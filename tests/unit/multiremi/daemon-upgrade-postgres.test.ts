import { describe, expect, it } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL ?? "postgres://multimira:multimira@localhost:5432/postgres";
const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(adminUrl).hostname);
let available = false;
if (local) {
  const admin = new Bun.SQL(adminUrl, { max: 1, connectionTimeout: 1 });
  try { await admin`SELECT 1`; available = true; } catch {} finally { await admin.end(); }
}
if (!available) console.warn("[daemon-upgrade-postgres] local PostgreSQL unavailable; skipping two-connection heartbeat race (no remote database is used)");

function phase(worker: Worker, expected: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const message = (event: MessageEvent) => {
      if (event.data.phase === "error") { cleanup(); reject(new Error("PostgreSQL heartbeat worker failed")); }
      else if (event.data.phase === expected) { cleanup(); resolve(event.data); }
    };
    const error = () => { cleanup(); reject(new Error("PostgreSQL heartbeat worker failed")); };
    const cleanup = () => { worker.removeEventListener("message", message); worker.removeEventListener("error", error); };
    worker.addEventListener("message", message);
    worker.addEventListener("error", error);
  });
}

describe.skipIf(!available)("automatic daemon upgrades on real PostgreSQL", () => {
  it("two independent connections handling concurrent heartbeats create exactly one pending row", async () => {
    const database = `mul418_upgrade_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
    const admin = new Bun.SQL(adminUrl, { max: 1 });
    let db: PostgresSyncDatabase | undefined;
    const workers: Worker[] = [];
    let created = false;
    try {
      await admin.unsafe(`CREATE DATABASE ${database}`);
      created = true;
      const url = new URL(adminUrl); url.pathname = `/${database}`;
      db = new PostgresSyncDatabase(url.toString());
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      const runtime = store.registerRuntime({ id: "rt_pg_upgrade", name: "PG upgrade", provider: "claude", daemonId: "dmn_pg_upgrade", metadata: { cli_version: "0.2.82" } });
      const agent = store.createAgent({ name: "Busy PG", provider: "claude", runtimeId: runtime.id });
      const task = store.createTask({ agentId: agent.id, runtimeId: runtime.id, prompt: "Keep upgrade pending" });
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);
      const ready: Promise<unknown>[] = [];
      for (let index = 0; index < 2; index++) {
        const worker = new Worker(new URL("./fixtures/postgres-daemon-heartbeat-worker.ts", import.meta.url).href);
        workers.push(worker);
        ready.push(phase(worker, "ready"));
        worker.postMessage({ databaseUrl: url.toString(), runtimeId: runtime.id });
      }
      await Promise.all(ready);
      const done = workers.map(worker => phase(worker, "done"));
      for (const worker of workers) worker.postMessage({ run: true });
      expect((await Promise.all(done)).map(value => value.status)).toEqual([200, 200]);
      const rows = db.query("SELECT status FROM multiremi_runtime_update_requests WHERE runtime_id = ?").all(runtime.id);
      expect(rows).toEqual([{ status: "pending" }]);
    } finally {
      for (const worker of workers) worker.terminate();
      db?.close();
      if (created) await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  }, 15_000);
});
