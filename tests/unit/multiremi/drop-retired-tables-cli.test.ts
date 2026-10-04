import { expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { reconcileUnifiedModel } from '@multiremi/store/unified-model-migration.js';
import { UNIFIED_MODEL_MIGRATION } from '@multiremi/store/unified-model-schema.js';
import { RETIRED_TABLE_SETS } from '../../../scripts/drop-retired-tables.js';

pendingTurnBackendTests('retired-table real CLI', fixture => {
  it('defaults to dry-run and executes both sets through the actual entry point', () => {
    const { db, store, databaseUrl } = fixture();
    const agent = store.createAgent({ name: 'CLI fixture', provider: 'codex' });
    store.createTask({ agentId: agent.id, prompt: 'preserved work' });
    const dir = mkdtempSync(join(tmpdir(), 'mul505-drop-cli-'));
    try {
      // Synthetic elapsed time exercises the seven-day gate without waiting.
      db.run('UPDATE multiremi_schema_migrations SET applied_at=? WHERE id=?',
        [new Date(Date.now() - 8 * 86_400_000).toISOString(), UNIFIED_MODEL_MIGRATION]);
      const report = reconcileUnifiedModel(db);
      expect(report.mismatches).toEqual([]);
      const reportPath = join(dir, 'report.json');
      const dbPath = join(dir, 'fixture.db');
      const backup = join(dir, 'backup');
      writeFileSync(reportPath, JSON.stringify(report));
      // The CLI gate accepts a nonempty backup; backup/restore validation has
      // separate coverage. SQLite uses an actual serialized fixture backup.
      writeFileSync(backup, databaseUrl ? 'synthetic CLI gate backup' : (db as unknown as Database).serialize());
      if (!databaseUrl) writeFileSync(dbPath, readFileSync(backup));
      const target = databaseUrl ? ['--postgres-env', 'MUL505_CLI_PG_URL'] : ['--sqlite', dbPath];
      const inspect = (fn: (handle: typeof db) => void) => {
        if (databaseUrl) return fn(db);
        const handle = openSqliteDatabase(dbPath, { readonly: true });
        try { fn(handle as unknown as typeof db); } finally { handle.close(); }
      };
      for (const set of ['mul432', 'mul493'] as const) {
        for (const execute of [false, true]) {
          const result = Bun.spawnSync({
            cmd: [process.execPath, 'run', resolve('scripts/drop-retired-tables.ts'), '--set', set,
              ...target, '--report', reportPath, ...(execute ? ['--execute', '--confirm-drop', '--backup', backup] : [])],
            env: { ...process.env, ...(databaseUrl ? { MUL505_CLI_PG_URL: databaseUrl } : {}) },
            stdout: 'pipe', stderr: 'pipe',
          });
          expect(result.stderr.toString()).toBe('');
          expect(result.exitCode).toBe(0);
          expect(JSON.parse(result.stdout.toString())).toMatchObject({ dry_run: !execute, tables: [...RETIRED_TABLE_SETS[set]] });
          inspect(handle => {
            const tables = new Set(handle.query(handle.dialect === "postgres"
              ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'"
              : "SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
            for (const table of RETIRED_TABLE_SETS[set]) expect(tables.has(table)).toBe(!execute);
            const after = reconcileUnifiedModel(handle);
            expect(after.mismatches).toEqual([]);
            expect(after.attempt_ids_digest).toBe(report.attempt_ids_digest);
            expect(after.counts).toEqual(report.counts);
          });
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
