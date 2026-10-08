import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { multiremiStateDir } from "@shared/home-paths.js";

/** Docker mounts HOME as its writable api-home volume; /app is image code. */
export function resolveMigrationReportDirectory(override = process.env.MULTIREMI_MIGRATION_REPORT_DIR): string {
  // The state-dir knob isolates tests. Its default is ~/.multiremi, so Docker's
  // writable HOME still owns ~/reports/migrations rather than the image's /app.
  return override?.trim() || join(dirname(multiremiStateDir()), "reports", "migrations");
}

/** Check the report's write/rename path before any startup schema mutation. */
export function prepareMigrationReportDirectory(dir: string): void {
  const probe = join(dir, `.write-check-${randomUUID()}`);
  const renamed = `${probe}.renamed`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "migration report write check\n", { mode: 0o600, flag: "wx" });
    renameSync(probe, renamed);
  } catch (cause) {
    throw new Error(`Migration report directory is not writable: ${dir}; check api-home ownership or MULTIREMI_MIGRATION_REPORT_DIR`, { cause });
  } finally {
    for (const path of [probe, renamed]) {
      try { unlinkSync(path); } catch { /* The probe might not have been created. */ }
    }
  }
}
