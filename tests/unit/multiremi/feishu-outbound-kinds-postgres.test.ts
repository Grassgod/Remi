import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { MultiremiFeishuBotOutboundDelivery } from "@multiremi/contracts/types.js";
import { configureKindBot } from "./feishu-outbound-kind-fixture.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
describe.skipIf(!adminUrl)("C5 delivery on real PostgreSQL", () => {
  const name = `c5_claim_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  let db: PostgresSyncDatabase, databaseUrl: string;
  let previousKey: string | undefined, previousJobs: string | undefined;
  beforeAll(async () => {
    previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    previousJobs = process.env.MULTIREMI_BACKGROUND_JOBS;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.MULTIREMI_BACKGROUND_JOBS = "1";
    const admin = new Bun.SQL(adminUrl!, { max: 1 });
    try { await admin.unsafe(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    databaseUrl = url.toString();
    db = new PostgresSyncDatabase(databaseUrl);
  });
  afterAll(async () => {
    db?.close();
    const admin = new Bun.SQL(adminUrl!, { max: 1 });
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
    if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
    if (previousJobs === undefined) delete process.env.MULTIREMI_BACKGROUND_JOBS; else process.env.MULTIREMI_BACKGROUND_JOBS = previousJobs;
  });

  it("runs full startup twice, races old/new claims on separate connections and delivers every row once", async () => {
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const f = configureKindBot(store);
    const firstTask = f.inbound("pg_0").taskId;
    const old = store.claimFeishuBotOutbound("local", "rt_kinds", undefined, true, true, true)!;
    const secondTask = f.inbound("pg_1").taskId;
    const capable = store.claimFeishuBotOutbound("local", "rt_kinds", undefined, true, true, true, true)!;
    expect(old.kind).toBeUndefined();
    expect(capable.kind).toBe("cot");
    for (const row of [old, capable]) expect(store.reportFeishuBotOutbound("local", "rt_kinds", row.id,
      { claimToken: row.claimToken, status: "sent", externalMessageId: `om_pg_${row.id}` })).toBe(true);
    const tasks = [firstTask, secondTask, ...Array.from({ length: 2 }, (_, i) => f.inbound(`pg_${i + 2}`).taskId)];
    const before = db.query("SELECT id, task_id, kind, body FROM multiremi_feishu_bot_outbound_deliveries ORDER BY id").all();
    runMigrations(db, { dialect: "postgres" });
    runMigrations(db, { dialect: "postgres" });
    expect(db.query("SELECT id, task_id, kind, body FROM multiremi_feishu_bot_outbound_deliveries ORDER BY id").all()).toEqual(before);
    const workers = [new Worker(new URL("./fixtures/postgres-feishu-kind-claim-worker.ts", import.meta.url).href),
      new Worker(new URL("./fixtures/postgres-feishu-kind-claim-worker.ts", import.meta.url).href)];
    const exchange = <T>(worker: Worker, message: object) => new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("PG claim worker timed out")); }, 15_000);
      const receive = (event: MessageEvent<any>) => {
        cleanup();
        if (event.data.phase === "error") reject(new Error(event.data.error)); else resolve(event.data);
      };
      const cleanup = () => { clearTimeout(timer); worker.removeEventListener("message", receive); };
      worker.addEventListener("message", receive);
      worker.postMessage(message);
    });
    const delivered = new Set<string>([old.id, capable.id]);
    const legacyTasks = new Set<string>([firstTask]);
    try {
      for (const worker of workers) await exchange(worker, { type: "init", databaseUrl });
      for (let round = 0; round < 16; round++) {
        const claims = await Promise.all(workers.map((worker, index) => exchange<{ row: MultiremiFeishuBotOutboundDelivery | null }>(worker,
          { type: "claim", supportsKinds: index === 1 })));
        const rows = claims.flatMap(value => value.row ? [value.row] : []);
        if (!rows.length) break;
        for (const row of rows) {
          expect(delivered.has(row.id)).toBe(false);
          delivered.add(row.id);
          if (!row.kind) legacyTasks.add(row.taskId!);
          expect(store.reportFeishuBotOutbound("local", "rt_kinds", row.id,
            { claimToken: row.claimToken, status: "sent", externalMessageId: `om_pg_${row.id}` })).toBe(true);
        }
      }
      expect(new Set((db.query("SELECT task_id FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'cot'").all() as any[]).map(row => row.task_id)))
        .toEqual(new Set(tasks));
      const splitTasks = (db.query("SELECT task_id FROM multiremi_feishu_bot_outbound_deliveries WHERE kind = 'cot' AND delivery_mode = 'split'").all() as any[])
        .map(row => String(row.task_id));
      expect(splitTasks.length + legacyTasks.size).toBe(tasks.length);
      expect(splitTasks).toContain(secondTask);
      for (const taskId of tasks) {
        if (store.getTask(taskId)?.status === "queued") {
          expect(store.claimTask("rt_kinds")?.id).toBe(taskId);
          store.startTask(taskId);
        }
        store.completeTask(taskId, { output: "PG answer" });
      }
      for (let round = 0; round < 8; round++) {
        const batch = store.claimFeishuBotOutbounds("local", "rt_kinds");
        if (!batch.length) break;
        for (const row of batch) {
          expect(delivered.has(row.id)).toBe(false);
          delivered.add(row.id);
          expect(store.reportFeishuBotOutbound("local", "rt_kinds", row.id,
            { claimToken: row.claimToken, status: "sent", externalMessageId: `om_pg_${row.id}` })).toBe(true);
        }
      }
      const final = db.query("SELECT id, status FROM multiremi_feishu_bot_outbound_deliveries").all() as any[];
      expect(final.every(row => row.status === "sent")).toBe(true);
      expect(delivered.size).toBe(final.length);
      expect(final.length).toBe(legacyTasks.size + splitTasks.length * 4);
    } finally {
      await Promise.all(workers.map(worker => exchange(worker, { type: "close" })));
      for (const worker of workers) worker.terminate();
    }
  }, 60_000);
});
