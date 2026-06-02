import { describe, it, expect } from "bun:test";
import { reconcileMcp, hashConfig } from "../../src/plugins/config-hub/reconcile.js";
import type { EntryMap, Manifest } from "../../src/plugins/config-hub/types.js";

const X = { command: "server-x", args: ["--a"] };
const X2 = { command: "server-x", args: ["--b"] }; // X modified
const X3 = { command: "server-x", args: ["--c"] }; // X modified differently

function base(map: EntryMap): Manifest {
  const m: Manifest = {};
  for (const [k, v] of Object.entries(map)) m[k] = hashConfig(v);
  return m;
}

describe("reconcileMcp", () => {
  it("create: new in DB → written to file", () => {
    const r = reconcileMcp({ x: X }, {}, {});
    expect(r.toFile).toEqual({ x: X });
    expect(r.imports).toEqual({});
    expect(r.disables).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.nextManifest.x).toBe(hashConfig(X));
  });

  it("unchanged: DB == file == base → idempotent no-op", () => {
    const r = reconcileMcp({ x: X }, { x: X }, base({ x: X }));
    expect(r.toFile).toEqual({ x: X });
    expect(r.imports).toEqual({});
    expect(r.disables).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it("DB changed only → write DB value to file", () => {
    const r = reconcileMcp({ x: X2 }, { x: X }, base({ x: X }));
    expect(r.toFile).toEqual({ x: X2 });
    expect(r.imports).toEqual({});
    expect(r.nextManifest.x).toBe(hashConfig(X2));
  });

  it("file changed only (model/user edit) → import back into DB", () => {
    const r = reconcileMcp({ x: X }, { x: X2 }, base({ x: X }));
    expect(r.toFile).toEqual({ x: X2 });
    expect(r.imports).toEqual({ x: X2 });
    expect(r.conflicts).toEqual([]);
    expect(r.nextManifest.x).toBe(hashConfig(X2));
  });

  it("both changed differently → conflict, file left as-is, base kept", () => {
    const r = reconcileMcp({ x: X2 }, { x: X3 }, base({ x: X }));
    expect(r.conflicts).toEqual(["x"]);
    expect(r.toFile).toEqual({ x: X3 }); // untouched
    expect(r.imports).toEqual({});
    expect(r.nextManifest.x).toBe(hashConfig(X)); // stays flagged next run
  });

  it("both changed to same value → no conflict", () => {
    const r = reconcileMcp({ x: X2 }, { x: X2 }, base({ x: X }));
    expect(r.conflicts).toEqual([]);
    expect(r.toFile).toEqual({ x: X2 });
  });

  it("user removed from file (hub wrote it before) → disable in DB", () => {
    const r = reconcileMcp({ x: X }, {}, base({ x: X }));
    expect(r.disables).toEqual(["x"]);
    expect(r.toFile).toEqual({});
    expect(r.nextManifest.x).toBeUndefined();
  });

  it("DB row deleted (hub wrote it before) → propagate delete from file", () => {
    const r = reconcileMcp({}, { x: X }, base({ x: X }));
    expect(r.toFile).toEqual({});
    expect(r.imports).toEqual({});
    expect(r.disables).toEqual([]);
    expect(r.nextManifest.x).toBeUndefined();
  });

  it("user/tool added (not from hub) → import into DB, keep in file", () => {
    const r = reconcileMcp({}, { x: X }, {});
    expect(r.imports).toEqual({ x: X });
    expect(r.toFile).toEqual({ x: X });
    expect(r.nextManifest.x).toBe(hashConfig(X));
  });

  it("vanished from both → cleaned from manifest", () => {
    const r = reconcileMcp({}, {}, base({ x: X }));
    expect(r.toFile).toEqual({});
    expect(r.nextManifest).toEqual({});
  });

  it("multiple servers reconciled independently", () => {
    const r = reconcileMcp(
      { keep: X, dbchg: X2, create: X },
      { keep: X, dbchg: X, deleted: X2, useradd: X },
      base({ keep: X, dbchg: X, deleted: X }),
    );
    // keep: unchanged; dbchg: DB wins; create: new in DB;
    // deleted: in base+file but not DB → propagate delete (gone from file);
    // useradd: in file only, not in base → import into DB, keep in file
    expect(r.toFile.keep).toEqual(X);
    expect(r.toFile.dbchg).toEqual(X2);
    expect(r.toFile.create).toEqual(X);
    expect(r.toFile.deleted).toBeUndefined();
    expect(r.toFile.useradd).toEqual(X);
    expect(r.imports).toEqual({ useradd: X });
  });
});
