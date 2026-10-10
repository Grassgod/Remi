import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runTests } from "../../../scripts/run-tests.js";
import { afterEach, expect, it, setSystemTime } from "bun:test";
import { createSqliteStoreSnapshotFactory, readConnectionPragma } from "../../helpers/sqlite-store-snapshot.js";
import { UNIFIED_MODEL_MIGRATION } from "@multiremi/store/unified-model-schema.js";
import { createResponsibleTestIssue } from "./helpers.js";

import { installFirstScreenHotspotIds } from "../../fixtures/multiremi/first-screen-hotspots-normalize.js";
import { installDeterministicIds } from "../../fixtures/multiremi/issue-detail-first-screen-fixture.js";
import { installAssigneeRefIds } from "../../fixtures/multiremi/assignee-ref-fixture.js";

const ownerOpenId = process.env.MULTIREMI_OWNER_OPEN_ID;
afterEach(() => {
  setSystemTime();
  if (ownerOpenId === undefined) delete process.env.MULTIREMI_OWNER_OPEN_ID;
  else process.env.MULTIREMI_OWNER_OPEN_ID = ownerOpenId;
});

it("keeps handles, rows, listeners and the first Issue number independent while sharing only migrated seed metadata", () => {
  const factory = createSqliteStoreSnapshotFactory();
  const first = factory.create();
  try {
    // Golden captures temporarily replace both globals. Restoration must be
    // exact so a later ordinary suite still hits the same immutable template.
    const originalRandom = crypto.getRandomValues;
    const originalDate = Date;
    for (const install of [installFirstScreenHotspotIds, installDeterministicIds, installAssigneeRefIds]) {
      const outputs: number[][] = [];
      for (let capture = 0; capture < 2; capture++) {
        const restore = install();
        try {
          const bytes = new Uint8Array(8);
          crypto.getRandomValues.call(crypto, bytes);
          outputs.push([...bytes]);
        }
        finally { restore(); }
        expect(crypto.getRandomValues).toBe(originalRandom);
        expect(Date).toBe(originalDate);
      }
      expect(outputs[0]).toEqual(outputs[1]);
    }
    expect(crypto.getRandomValues.call(crypto, new Uint8Array(1))).toHaveLength(1);
    first.store.ensureLocalWorkspace();
    const agent = first.store.createAgent({ name: "First", provider: "codex" });
    const issue = createResponsibleTestIssue(first.store, { title: "First" });
    let firstEvents = 0;
    const unsubscribe = first.store.onTaskEnqueued(() => firstEvents++);
    try {
      const second = factory.create();
      try {
        second.store.ensureLocalWorkspace();
        expect(second.db).not.toBe(first.db);
        expect(second.store).not.toBe(first.store);
        expect(second.store.getAgent(agent.id)).toBeNull();
        expect(second.store.getIssue(issue.id)).toBeNull();
        const otherAgent = second.store.createAgent({ name: "Second", provider: "codex" });
        expect(otherAgent.id).not.toBe(agent.id);
        second.store.createTask({ agentId: otherAgent.id, prompt: "Only the second Store sees this" });
        expect(firstEvents).toBe(0);
        const secondIssue = createResponsibleTestIssue(second.store, { title: "Second" });
        expect(secondIssue.number).toBe(issue.number);
        expect(first.store.getAgent(agent.id)?.name).toBe("First");
        expect(second.db.query("PRAGMA foreign_keys").get()).toEqual(first.db.query("PRAGMA foreign_keys").get());
        const applied = (db: typeof first.db) => db.query("SELECT applied_at FROM multiremi_schema_migrations WHERE id = ?").get(UNIFIED_MODEL_MIGRATION);
        expect(applied(second.db)).toEqual(applied(first.db));
      } finally {
        second.db.close();
      }
    } finally {
      unsubscribe();
    }
    expect(factory.stats()).toMatchObject({ coldBootstraps: 1, clones: 2, freshFallbacks: 0, storeInitializations: 3 });
  } finally {
    first.db.close();
  }
});

it("falls back to a real empty-schema bootstrap when the environment differs", () => {
  const factory = createSqliteStoreSnapshotFactory();
  const first = factory.create();
  first.db.close();
  process.env.MULTIREMI_OWNER_OPEN_ID = "sqlite_snapshot_alternate_owner";
  const second = factory.create();
  try {
    expect(factory.stats()).toMatchObject({ coldBootstraps: 2, clones: 1, freshFallbacks: 1 });
  } finally {
    second.db.close();
  }
});

it("uses fresh migration timestamps under a controlled clock instead of cloning the old seed", () => {
  const factory = createSqliteStoreSnapshotFactory();
  const first = factory.create();
  first.db.close();
  const time = new Date("2020-01-02T03:04:05.000Z");
  setSystemTime(time);
  const second = factory.create();
  try {
    expect(second.db.query<{ applied_at: string }, [string]>("SELECT applied_at FROM multiremi_schema_migrations WHERE id = ?").get(UNIFIED_MODEL_MIGRATION)?.applied_at).toBe(time.toISOString());
    expect(factory.stats()).toMatchObject({ coldBootstraps: 2, clones: 1, freshFallbacks: 1 });
  } finally {
    second.db.close();
  }
});

// No database needed: unknown labels must preserve the scalar, malformed native
// results must fail before any connection setting can be overwritten.
it("reads connection PRAGMAs by scalar shape and rejects missing or invalid values", () => {
  const database = (row: Record<string, unknown> | null) => ({
    query: () => ({ get: () => row }),
  }) as unknown as Parameters<typeof readConnectionPragma>[0];
  expect(readConnectionPragma(database({ arbitrary_native_label: 1 }), "foreign_keys")).toBe(1);
  for (const row of [null, {}, { foreign_keys: undefined }, { foreign_keys: "1" }, { foreign_keys: NaN }, { foreign_keys: 1, extra: 0 }]) {
    expect(() => readConnectionPragma(database(row), "foreign_keys")).toThrow("Unsupported SQLite connection PRAGMA result");
  }
});


it("permits genuine late-import clock and UUID restoration while injected inputs stay fresh", async () => {
  // A child is necessary: this suite's ordinary imports already loaded the
  // snapshot helper. Its configured preload captures only pure native refs.
  const directory = mkdtempSync(join(tmpdir(), "snapshot-late-import-"));
  const file = join(directory, "late-import.test.ts");
  const helper = resolve(import.meta.dir, "../../helpers/sqlite-store-snapshot.ts");
  try {
    writeFileSync(file, `import { test, expect, setSystemTime } from "bun:test";
test("late import restores real inputs", async () => {
  const originalUUID = crypto.randomUUID;
  setSystemTime(new Date("2020-01-01"));
  try {
    const { createSqliteStoreSnapshotFactory } = await import(${JSON.stringify(helper)});
    const factory = createSqliteStoreSnapshotFactory();
    const controlled = factory.create(); controlled.db.close();
    expect(factory.stats()).toMatchObject({ coldBootstraps: 1, clones: 0, freshFallbacks: 1 });
    setSystemTime();
    const restored = factory.create(); restored.db.close();
    expect(factory.stats()).toMatchObject({ coldBootstraps: 2, clones: 1, freshFallbacks: 1 });
    crypto.randomUUID = () => "00000000-0000-4000-8000-000000000000";
    const injected = factory.create(); injected.db.close();
    expect(factory.stats()).toMatchObject({ coldBootstraps: 3, clones: 1, freshFallbacks: 2 });
    crypto.randomUUID = originalUUID;
    const recovered = factory.create(); recovered.db.close();
    expect(factory.stats()).toMatchObject({ coldBootstraps: 3, clones: 2, freshFallbacks: 2 });
  } finally { setSystemTime(); crypto.randomUUID = originalUUID; }
});
`);
    expect(await runTests([file])).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 10_000);
