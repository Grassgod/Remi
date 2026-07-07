/**
 * Must be imported BEFORE any module that creates a bun:sqlite Database instance.
 * macOS ships a proprietary SQLite that disables loadExtension().
 * This swaps it for a vanilla build from Homebrew or Miniconda.
 */
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

if (process.platform === "darwin") {
  const envPath = process.env.SQLITE_LIB_PATH;
  const candidates = envPath
    ? [envPath]
    : [
        "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
        "/opt/miniconda3/lib/libsqlite3.dylib",
        "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
      ];

  for (const p of candidates) {
    if (statSync(p, { throwIfNoEntry: false })) {
      try {
        Database.setCustomSQLite(p);
        break;
      } catch {
        // incompatible arch or other issue, try next
      }
    }
  }
}
