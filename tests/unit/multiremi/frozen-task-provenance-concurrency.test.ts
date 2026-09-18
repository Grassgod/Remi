import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const previousKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
afterEach(() => {
  if (previousKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = previousKey;
  resetMultiremiTestEnv();
});

function seed(store: MultiremiStore, database: SqlDatabase, provider: "codex" | "claude", suffix: string,
  mode: "api_key" | "env" = "api_key") {
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 79).toString("base64");
  const original = store.registerRuntime({ id: `origin-${suffix}`, name: "Original identity", provider,
    workspaceId: "local", ownerId: "local", metadata: { [`${provider}_profiles`]: 1 } });
  const replacement = store.registerRuntime({ id: `replacement-${suffix}`, name: "Canonical identity", provider,
    workspaceId: "local", ownerId: "local", metadata: { [`${provider}_profiles`]: 1 } });
  const connection = { name: "frozen", base_url: "https://frozen.example/v1", model: "frozen-model",
    auth_mode: mode, env_key: mode === "env" ? `REMI_${provider.toUpperCase()}_FROZEN_KEY` : "" };
  const profile = provider === "codex"
    ? store.setRuntimeCodexProfile(original.id, connection, mode === "api_key" ? "fixture-frozen-key" : undefined)!
    : store.setRuntimeClaudeProfile(original.id, connection, mode === "api_key" ? "fixture-frozen-key" : undefined)!;
  const agent = store.createAgent({ name: `Frozen-${suffix}`, provider, model: "frozen-model" });
  const task = store.createTask({ agentId: agent.id, prompt: "preserve a recoverable frozen connection" });
  database.run(`UPDATE multiremi_tasks SET provider = ?, ${provider}_profile = ?,
    execution_fingerprint = 'historical-frozen', execution_runtime_id = ? WHERE id = ?`,
  [provider, JSON.stringify(profile), original.id, task.id]);
  return { original, replacement, profile, agent, task };
}

function readOrigin(database: SqlDatabase, taskId: string): string | null {
  return database.query("SELECT execution_runtime_id FROM multiremi_tasks WHERE id = ?")
    .get(taskId).execution_runtime_id;
}

describe("frozen provenance recovery transaction", () => {
  for (const provider of ["codex", "claude"] as const) {
    it(`${provider}: identity merge preserves encoded env provenance before startup recovery runs`, () => {
      const store = createLocalStore();
      const database = db! as unknown as SqlDatabase;
      const fixture = seed(store, database, provider, "transition", "env");
      database.run(`UPDATE multiremi_tasks SET execution_runtime_id = NULL,
        execution_fingerprint = ? WHERE id = ?`,
      [`chat-workspace-transition-${encodeURIComponent(fixture.original.id)}:frozen`, fixture.task.id]);
      expect(store.mergeRuntimeInto(fixture.original.id, fixture.replacement.id).deleted).toBe(true);
      runMigrations(database);
      expect(readOrigin(database, fixture.task.id)).toBe(fixture.replacement.id);
      const claimed = store.claimTask(fixture.replacement.id);
      expect(claimed?.id).toBe(fixture.task.id);
      expect(claimed?.[provider === "codex" ? "codexProfile" : "claudeProfile"]).toEqual(fixture.profile);
    });

    it(`${provider}: identity merge leaves an unproven historical env snapshot unknown`, () => {
      const store = createLocalStore();
      const database = db! as unknown as SqlDatabase;
      const fixture = seed(store, database, provider, "ambiguous", "env");
      database.run("UPDATE multiremi_tasks SET execution_runtime_id = NULL, runtime_id = ? WHERE id = ?",
        [fixture.original.id, fixture.task.id]);
      expect(store.mergeRuntimeInto(fixture.original.id, fixture.replacement.id).deleted).toBe(true);
      runMigrations(database);
      expect(readOrigin(database, fixture.task.id)).toBeNull();
      expect(store.claimTask(fixture.replacement.id)).toBeNull();
      store.refreshQueuedCapabilityWaitReasons(Date.now() + 180_000);
      expect(store.getTask(fixture.task.id)?.waitReason).toContain("历史快照缺少来源 Runtime");
    });

    it(`${provider}: rolls back a workspace recovery if a later snapshot write fails`, () => {
      const store = createLocalStore();
      const database = db! as unknown as SqlDatabase;
      const first = seed(store, database, provider, "first");
      const second = seed(store, database, provider, "second");
      database.run("UPDATE multiremi_tasks SET execution_runtime_id = NULL");
      const run = database.run.bind(database);
      let writes = 0;
      const mock = spyOn(database, "run").mockImplementation((sql: string, ...params: unknown[]) => {
        if (/UPDATE multiremi_tasks SET execution_runtime_id = \?/.test(sql) && ++writes === 2) {
          throw new Error("fixture write interruption");
        }
        return run(sql, ...params);
      });
      try { expect(() => runMigrations(database)).toThrow("fixture write interruption"); }
      finally { mock.mockRestore(); }
      expect(writes).toBe(2);
      expect(readOrigin(database, first.task.id)).toBeNull();
      expect(readOrigin(database, second.task.id)).toBeNull();
      runMigrations(database);
      expect(readOrigin(database, first.task.id)).toBe(first.original.id);
      expect(readOrigin(database, second.task.id)).toBe(second.original.id);
    });
  }

  it("batches 200 distinct missing credential owners without guessing provenance on repeated startup", () => {
    const store = createLocalStore();
    const database = db! as unknown as SqlDatabase;
    const fixture = seed(store, database, "codex", "missing");
    for (let index = 0; index < 200; index++) {
      database.run(`INSERT INTO multiremi_tasks (id, agent_id, workspace_id, provider, prompt,
        codex_profile, execution_fingerprint, created_at, updated_at)
        VALUES (?, ?, 'local', 'codex', 'missing credential', ?, 'frozen', ?, ?)`,
      [`missing-${index}`, fixture.agent.id,
        JSON.stringify({ ...fixture.profile, credential_id: `rck_missing_${index}` }),
        "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z"]);
    }
    const query = database.query.bind(database);
    let ownerQueries = 0;
    let largestParameterCount = 0;
    const mock = spyOn(database, "query").mockImplementation((sql: string) => {
      if (/SELECT[\s\S]*FROM multiremi_runtime_provider_credentials c/.test(sql)) {
        ownerQueries++;
        largestParameterCount = Math.max(largestParameterCount, (sql.match(/\?/g) ?? []).length);
      }
      return query(sql);
    });
    try {
      for (let startup = 0; startup < 2; startup++) {
        ownerQueries = 0;
        runMigrations(database);
        expect(ownerQueries).toBeLessThanOrEqual(2);
        expect(largestParameterCount).toBeLessThanOrEqual(129);
        expect(database.query(`SELECT COUNT(*) AS count FROM multiremi_tasks
          WHERE id LIKE 'missing-%' AND execution_runtime_id IS NULL`).get().count).toBe(200);
      }
    } finally { mock.mockRestore(); }
  });
});

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const pgAvailable = await (async () => {
  const probe = new Bun.SQL(pgAdminUrl, { max: 1 });
  try { await probe`SELECT 1`; return true; }
  catch (error) { if (process.env.MULTIREMI_TEST_POSTGRES_URL) throw error; return false; }
  finally { await probe.end(); }
})();

function participant(input: {
  databaseUrl: string; role: "backfill" | "merge"; originalId: string; replacementId: string;
  barrier: SharedArrayBuffer; pauseAfterRead: boolean;
}) {
  const worker = new Worker(new URL("./fixtures/postgres-provenance-race-worker.ts", import.meta.url).href);
  const phases = new Set<string>();
  let failure: string | undefined;
  worker.onmessage = ({ data }) => { phases.add(data.phase); if (data.phase === "error") failure = data.error; };
  worker.onerror = event => { failure = event.message; };
  worker.postMessage(input);
  return { worker, phases, async until(phase: string) {
    const deadline = Date.now() + 20_000;
    while (!phases.has(phase)) {
      if (failure) throw new Error(failure);
      if (Date.now() > deadline) throw new Error(`Worker ${input.role} never reached ${phase}`);
      await Bun.sleep(10);
    }
  } };
}

describe.skipIf(!pgAvailable)("frozen provenance and Runtime identity merge on PostgreSQL", () => {
  const databaseName = `multiremi_provenance_race_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  let databaseUrl: string;
  let admin: InstanceType<typeof Bun.SQL>;
  let observer: InstanceType<typeof Bun.SQL>;
  let pg: PostgresSyncDatabase;
  let store: MultiremiStore;
  beforeAll(async () => {
    admin = new Bun.SQL(pgAdminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    const url = new URL(pgAdminUrl);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    pg = new PostgresSyncDatabase(databaseUrl);
    store = new MultiremiStore(pg);
    store.ensureLocalWorkspace();
    observer = new Bun.SQL(databaseUrl, { max: 1 });
  });
  afterAll(async () => {
    pg?.close();
    await observer?.end();
    if (admin) {
      try { await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); }
      finally { await admin.end(); }
    }
  });

  for (const provider of ["codex", "claude"] as const) {
    for (const first of ["backfill", "merge"] as const) {
      it(`${provider}: ${first} first cannot leave recovered provenance on the deleted identity`, async () => {
        const fixture = seed(store, pg, provider, `${provider}-${first}`);
        const barrier = new SharedArrayBuffer(4);
        const signal = new Int32Array(barrier);
        const options = { databaseUrl, originalId: fixture.original.id,
          replacementId: fixture.replacement.id, barrier };
        const backfill = participant({ ...options, role: "backfill", pauseAfterRead: first === "backfill" });
        // Constructors run schema migrations, which are separate from the
        // concurrent source-recovery/identity-merge operation under test.
        await backfill.until("ready");
        const merge = participant({ ...options, role: "merge", pauseAfterRead: first === "merge" });
        try {
          await merge.until("ready");
          pg.run("UPDATE multiremi_tasks SET execution_runtime_id = NULL WHERE id = ?", [fixture.task.id]);
          const leader = first === "backfill" ? backfill : merge;
          const follower = first === "backfill" ? merge : backfill;
          leader.worker.postMessage({ start: true });
          await leader.until("owner-read");
          follower.worker.postMessage({ start: true });
          // Observe actual database lock contention, not a timing guess. Old
          // code allows merge to commit in the owner-read / snapshot-write gap.
          const deadline = Date.now() + 10_000;
          let blocked = false;
          while (!blocked && !follower.phases.has("committed") && Date.now() < deadline) {
            const rows = await observer`SELECT pid FROM pg_stat_activity
              WHERE datname = ${databaseName} AND wait_event_type = 'Lock'`;
            blocked = rows.length > 0;
            if (!blocked) await Bun.sleep(10);
          }
          Atomics.store(signal, 0, 1);
          Atomics.notify(signal, 0);
          await Promise.all([backfill.until("committed"), merge.until("committed")]);
          expect(readOrigin(pg, fixture.task.id)).toBe(fixture.replacement.id);
          expect(store.getRuntime(fixture.original.id)).toBeNull();
          const credential = pg.query("SELECT runtime_id FROM multiremi_runtime_provider_credentials WHERE id = ?")
            .get(fixture.profile.credential_id);
          expect(credential.runtime_id).toBe(fixture.replacement.id);
          expect(store.claimTask(fixture.replacement.id)?.id).toBe(fixture.task.id);
          expect(provider === "codex"
            ? store.getRuntimeCodexProfileKey(fixture.replacement.id, fixture.profile.credential_id!)
            : store.getRuntimeClaudeProfileKey(fixture.replacement.id, fixture.profile.credential_id!))
            .toBe("fixture-frozen-key");
          store.startTask(fixture.task.id);
          store.completeTask(fixture.task.id, { output: "original credential preserved after identity merge" });
          expect(blocked).toBe(true);
        } finally {
          Atomics.store(signal, 0, 1);
          Atomics.notify(signal, 0);
          backfill.worker.terminate();
          merge.worker.terminate();
        }
      }, 30_000);
    }
  }
});
