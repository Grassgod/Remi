import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { compareRollbackVersions, minimumRollbackVersion } from "@multiremi/store/rollback-floor.js";
import { UNIFIED_MODEL_MIGRATION } from "@multiremi/store/unified-model-schema.js";

describe("schema rollback floor", () => {
  it("derives the floor from applied migrations, ignoring unrelated markers", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE multiremi_schema_migrations(id TEXT PRIMARY KEY)");
      expect(minimumRollbackVersion(db)).toBeNull();
      db.run("INSERT INTO multiremi_schema_migrations VALUES(?)", ["unrelated"]);
      expect(minimumRollbackVersion(db)).toBeNull();
      db.run("INSERT INTO multiremi_schema_migrations VALUES(?)", [UNIFIED_MODEL_MIGRATION]);
      expect(minimumRollbackVersion(db)).toBe("0.2.89");
    } finally { db.close(); }
  });

  it("compares stable versions numerically and refuses unverified versions", () => {
    expect(compareRollbackVersions("v0.2.89", "0.2.89")).toBe(0);
    expect(compareRollbackVersions("0.2.88", "0.2.89")).toBeLessThan(0);
    expect(compareRollbackVersions("0.2.100", "0.2.89")).toBeGreaterThan(0);
    expect(compareRollbackVersions("0.10.0", "0.2.89")).toBeGreaterThan(0);
    expect(compareRollbackVersions("garbage", "0.2.89")).toBeNull();
    expect(compareRollbackVersions("0.2.89-rc.1", "0.2.89")).toBeNull();
  });
});
