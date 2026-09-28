// MUL-473 (S9-2, PR2): guards for the `/api/runtimes` workspace filter.
//
// `GET /api/runtimes` read every Runtime in the deployment and then discarded
// the other workspaces, hydrating each survivor with three extra queries. The
// filter is now a SQL predicate and the two list-shaped derived reads are
// batched; the response must be identical.
import { afterEach, describe, expect, it } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database.js";

let databases: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];

afterEach(async () => {
  for (const database of databases) await database.dispose();
  databases = [];
});

const AUTH_TOKEN = "mul473-auth-token";

interface Probe {
  statements: number;
  bySql: Map<string, number>;
  reset(): void;
}

function createProbe(): Probe {
  return {
    statements: 0,
    bySql: new Map(),
    reset() {
      this.statements = 0;
      this.bySql = new Map();
    },
  };
}

function countingDatabase(raw: SqlDatabase, probe: Probe): SqlDatabase {
  const record = (sql: string): void => {
    probe.statements += 1;
    const key = sql.replace(/\s+/g, " ").trim();
    probe.bySql.set(key, (probe.bySql.get(key) ?? 0) + 1);
  };
  const wrap = (statement: SqlStatement, sql: string): SqlStatement => new Proxy(statement, {
    get(target, property) {
      const value = target[property as keyof SqlStatement];
      if (["get", "all", "run", "values"].includes(String(property))) {
        return (...params: unknown[]) => {
          record(sql);
          return (value as (...args: unknown[]) => unknown).apply(target, params);
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const wrapped: SqlDatabase = {
    query: (sql) => wrap(raw.query(sql) as unknown as SqlStatement, sql),
    prepare: (sql) => wrap(raw.prepare(sql) as unknown as SqlStatement, sql),
    run(sql, ...params) {
      record(sql);
      const bindings = (params.length === 1 && Array.isArray(params[0]) ? params[0] : params) as SQLQueryBindings[];
      return raw.run(sql, bindings);
    },
    exec: (sql) => {
      record(sql);
      raw.exec(sql);
    },
    transaction: (fn) => raw.transaction(fn),
    close: () => raw.close(),
  };
  return new Proxy(raw, {
    get(target, property) {
      const source = property in wrapped ? wrapped : target;
      const value = Reflect.get(source, property);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

interface Harness {
  store: MultiremiStore;
  db: SqlDatabase;
  probe: Probe;
  app: ReturnType<typeof createMultiremiApp>;
}

async function createHarness(): Promise<Harness> {
  const database = await openHotspotDatabase();
  databases.push(database);
  const db = database.db;
  const probe = createProbe();
  const store = new MultiremiStore(countingDatabase(db, probe));
  const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
  return { store, db, probe, app };
}

async function seedReader(store: MultiremiStore, workspaceId = "local"): Promise<{ userId: string; token: string }> {
  const user = store.getOrCreateUser({ externalId: `reader-${workspaceId}`, email: `reader-${workspaceId}@example.test`, name: "Reader" });
  store.createWorkspaceMember({ id: `mem_${workspaceId}_${user.id}`, workspaceId, userId: user.id, name: "Reader", role: "member" });
  const credential = await store.createAccessToken({
    name: "MUL-473 auth test",
    type: "pat",
    userId: user.id,
    workspaceId,
    purpose: "session",
  });
  return { userId: user.id, token: credential.token };
}

describe("MUL-473 runtimes list", () => {
  async function seedRuntimes(): Promise<Harness & { headers: Record<string, string> }> {
    const harness = await createHarness();
    harness.store.ensureLocalWorkspace();
    const reader = await seedReader(harness.store);
    const otherWorkspace = harness.store.createWorkspace({ name: "Other fleet", slug: "other-fleet" });
    harness.store.createWorkspaceMember({
      id: `mem_${otherWorkspace.id}_${reader.userId}`,
      workspaceId: otherWorkspace.id,
      userId: reader.userId,
      name: "Reader",
      role: "member",
    });
    for (let index = 0; index < 6; index += 1) {
      harness.store.registerRuntime({
        id: `rt_other_${index}`,
        name: `Other runtime ${index}`,
        provider: "codex",
        workspaceId: otherWorkspace.id,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      const runtime = harness.store.registerRuntime({
        id: `rt_local_${index}`,
        name: `Local runtime ${index}`,
        provider: index === 0 ? "codex" : "claude",
        workspaceId: "local",
        ownerId: reader.userId,
        // Public so the reading member may also use the model catalog route
        // below; the list assertion itself does not depend on it.
        visibility: "public",
      });
      harness.store.updateRuntimeModels(runtime.id, [
        { id: `model_${index}`, label: `Model ${index}`, provider: runtime.provider, default: true },
      ]);
    }
    return {
      ...harness,
      headers: { Authorization: `Bearer ${reader.token}`, "X-Workspace-ID": "local" },
    };
  }

  it("returns the same runtimes and shapes as the unfiltered read", async () => {
    const harness = await seedRuntimes();
    const response = await harness.app.request("/api/runtimes", { headers: harness.headers });
    expect(response.status).toBe(200);
    const listed = await response.json() as Array<Record<string, unknown>>;
    expect(listed.map((runtime) => runtime.id).sort()).toEqual(["rt_local_0", "rt_local_1", "rt_local_2"]);

    // Field-for-field against the fully hydrated per-runtime path.
    const expected = harness.store.listRuntimes()
      .filter((runtime) => (runtime.workspaceId ?? "local") === "local")
      .map((runtime) => runtime.id).sort();
    expect(listed.map((runtime) => runtime.id).sort()).toEqual(expected);
    const hydrated = new Map(harness.store.listRuntimesForWorkspace("local").map((runtime) => [runtime.id, runtime]));
    for (const runtime of listed) {
      const source = hydrated.get(runtime.id as string)!;
      // Compared against `runtimeCompatibilityResponse`' own field list.
      const { launch_header: launchHeader, last_seen_at: lastSeenAt, ...rest } = runtime;
      expect(rest).toEqual({
        id: source.id,
        workspace_id: source.workspaceId,
        daemon_id: source.daemonId,
        daemon_display_name: source.daemonDisplayName,
        name: source.name,
        runtime_mode: source.runtimeMode,
        provider: source.provider,
        execution_group_id: source.executionGroupId ?? null,
        execution_group_ids: source.executionGroupIds ?? [],
        status: source.status,
        device_info: source.deviceInfo,
        metadata: source.metadata,
        owner_id: source.ownerId,
        visibility: source.visibility,
        created_at: source.createdAt,
        updated_at: source.updatedAt,
      });
      expect(lastSeenAt).toBe(source.lastHeartbeatAt);
      expect(typeof launchHeader).toBe("string");
    }
    // The batched model catalog is what `/api/models` reads: same providers,
    // same model ids, same order as the hydrated rows carry.
    const models = await harness.app.request("/api/models?runtime_id=rt_local_2", { headers: harness.headers });
    expect(models.status).toBe(200);
    const catalog = await models.json() as { providers: Array<{ provider: string; models: Array<{ id: string }> }> };
    const claude = catalog.providers.find((provider) => provider.provider === "claude")!;
    expect(claude.models.map((model) => model.id)).toContain("model_2");
    // And the batched rows carry exactly what the per-runtime hydration does.
    const perRuntime = harness.store.getRuntime("rt_local_2")!;
    expect(perRuntime.models.map((model) => model.id).sort())
      .toEqual(hydrated.get("rt_local_2")!.models.map((model) => model.id).sort());
  }, 20000);

  it("does not read the other workspaces' runtimes or their models", async () => {
    const harness = await seedRuntimes();
    // Compare equally warm authentication; main throttles its first-use stamp.
    const warmup = await harness.app.request("/api/runtimes", { headers: harness.headers });
    expect(warmup.status).toBe(200);
    await warmup.arrayBuffer();
    harness.probe.reset();
    const response = await harness.app.request("/api/runtimes", { headers: harness.headers });
    expect(response.status).toBe(200);
    // The workspace predicate is in SQL, so the other fleet's rows never come
    // back: the model read asks for the three local ids, not nine.
    const modelReads = [...harness.probe.bySql.entries()].filter(([sql]) =>
      sql.includes("FROM multiremi_runtime_models"));
    expect(modelReads).toHaveLength(1);
    expect(modelReads[0]![1]).toBe(1);
    const groupReads = [...harness.probe.bySql.entries()].filter(([sql]) =>
      sql.includes("FROM multiremi_execution_group_members"));
    expect(groupReads).toHaveLength(1);
    // The number of derived statements does not grow with the runtime count.
    const before = harness.probe.statements;
    harness.store.registerRuntime({ id: "rt_local_9", name: "One more", provider: "claude", workspaceId: "local" });
    harness.store.updateRuntimeModels("rt_local_9", [
      { id: "model_9", label: "Model 9", provider: "claude", default: true },
    ]);
    harness.probe.reset();
    expect((await harness.app.request("/api/runtimes", { headers: harness.headers })).status).toBe(200);
    const after = harness.probe.statements;
    expect(after).toBe(before);
  }, 20000);

  it("keeps the daemon token bound to its own runtime", async () => {
    const harness = await seedRuntimes();
    const daemonCredential = await harness.store.createAccessToken({
      name: "MUL-473 daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon_a",
    });
    harness.store.registerRuntime({
      id: "rt_daemon_a",
      name: "Daemon A runtime",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon_a",
    });
    harness.store.registerRuntime({
      id: "rt_daemon_b",
      name: "Daemon B runtime",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon_b",
    });
    const response = await harness.app.request("/api/runtimes", {
      headers: { Authorization: `Bearer ${daemonCredential.token}`, "X-Workspace-ID": "local" },
    });
    expect(response.status).toBe(200);
    const listed = await response.json() as Array<{ id: string }>;
    expect(listed.map((runtime) => runtime.id)).toEqual(["rt_daemon_a"]);
  }, 20000);
});
