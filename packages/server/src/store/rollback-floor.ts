import type { SqlDatabase } from "./db/postgres.js";
import { UNIFIED_MODEL_MIGRATION } from "./unified-model-schema.js";

const ROLLBACK_FLOORS = [
  { migration: UNIFIED_MODEL_MIGRATION, version: "0.2.89" },
] as const;

/** Unknown or prerelease targets cannot establish a safe rollback version. */
export function compareRollbackVersions(left: string, right: string): number | null {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(value.trim())?.slice(1, 4).map(Number);
  const a = parse(left), b = parse(right);
  if (!a || !b || [...a, ...b].some(value => !Number.isSafeInteger(value))) return null;
  for (let index = 0; index < 3; index++) {
    const difference = a[index]! - b[index]!;
    if (difference) return difference;
  }
  return 0;
}

/** The database's applied irreversible migrations determine its rollback floor. */
export function minimumRollbackVersion(db: SqlDatabase): string | null {
  let minimum: string | null = null;
  for (const floor of ROLLBACK_FLOORS) {
    if (db.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(floor.migration)
      && (minimum === null || compareRollbackVersions(floor.version, minimum)! > 0)) minimum = floor.version;
  }
  return minimum;
}
