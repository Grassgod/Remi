/**
 * One-time COPY migration from the legacy ~/.cc-switch layout to ~/.remi.
 *
 * Older Remi installs persisted config-hub data under ~/.cc-switch (DB +
 * installed skills). This copies it into the new ~/.remi locations so existing
 * users keep their MCP configs / skills after the de-brand. It:
 *   - copies ONLY when the source exists AND the destination is absent,
 *   - never deletes or mutates the old ~/.cc-switch tree,
 *   - is idempotent (a second run is a no-op once the destination exists),
 *   - is atomic for the DB file (copy to temp, then rename).
 *
 * Must run BEFORE openConfigHubDb()/plugin.migrate() open the new DB.
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function migrateLegacyConfigStore(home: string = homedir()): void {
  const oldDb = join(home, ".cc-switch", "cc-switch.db");
  const newDb = join(home, ".remi", "config-hub.db");
  if (existsSync(oldDb) && !existsSync(newDb)) {
    mkdirSync(dirname(newDb), { recursive: true });
    const tmp = `${newDb}.tmp.${process.pid}.${Date.now()}`;
    try {
      copyFileSync(oldDb, tmp);
      renameSync(tmp, newDb);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort temp cleanup
      }
      throw e;
    }
  }

  const oldSkills = join(home, ".cc-switch", "skills");
  const newSkills = join(home, ".remi", "skills");
  if (existsSync(oldSkills) && !existsSync(newSkills)) {
    mkdirSync(dirname(newSkills), { recursive: true });
    cpSync(oldSkills, newSkills, { recursive: true });
  }
}
