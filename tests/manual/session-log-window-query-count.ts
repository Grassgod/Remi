#!/usr/bin/env bun
/**
 * Count the SQL statements behind each session log window probe.
 *
 *   bun run tests/manual/session-log-window-query-count.ts [--verbose]
 *
 * Seeds `tests/fixtures/multiremi/session-log-window-fixture.ts` into an
 * in-memory SQLite store and reads every probe through `app.request()`, counting
 * each executed statement (`get` / `all` / `run` / `values`). Each credential
 * makes one warm-up request first so its throttled `last_used_at` write is not
 * counted. Local SQLite statement counts only: no PostgreSQL bridge, HTTP or
 * latency. To count an older implementation, check out its
 * `packages/server/src` over this tree and run the same command.
 */
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  revealRunningTurnCard,
  seedSessionLogWindowFixture,
  sessionLogWindowProbes,
  sessionLogWindowRevealedProbes,
  type SessionLogWindowProbe,
} from "../fixtures/multiremi/session-log-window-fixture.js";

const verbose = process.argv.includes("--verbose");
const raw = openSqliteDatabase(":memory:") as unknown as SqlDatabase;

let counting = false, statements = 0;
const bySql = new Map<string, number>();
const count = (sql: string) => {
  if (!counting) return;
  statements += 1;
  const key = sql.replace(/\s+/g, " ").trim().slice(0, 140);
  bySql.set(key, (bySql.get(key) ?? 0) + 1);
};
const counted = (statement: object, sql: string) => new Proxy(statement, {
  get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value !== "function") return value;
    return ["get", "all", "run", "values"].includes(String(property))
      ? (...args: unknown[]) => { count(sql); return value.apply(target, args); }
      : value.bind(target);
  },
});
// Wrap a facade, not the driver: the driver's own query/prepare calls stay uncounted.
const wrapped = {
  query: (sql: string) => counted(raw.query(sql), sql),
  prepare: (sql: string) => counted(raw.prepare(sql), sql),
  run: (sql: string, ...params: unknown[]) => { count(sql); return (raw.run as (...args: unknown[]) => unknown)(sql, ...params); },
};
const db = new Proxy(raw, { get(target, property) {
  const source = property in wrapped ? wrapped : target;
  const value = Reflect.get(source, property);
  return typeof value === "function" ? value.bind(source) : value;
} });
const store = new MultiremiStore(db);
const fixture = await seedSessionLogWindowFixture(store);
counting = true;

const app = createMultiremiApp({ store, authToken: "session-log-window-count" });
const headers = (probe: SessionLogWindowProbe) => ({ headers: { Authorization: `Bearer ${fixture.tokens[probe.auth]}` } });
for (const token of Object.values(fixture.tokens)) await app.request("/api/me", { headers: { Authorization: `Bearer ${token}` } });

const read = async (probes: SessionLogWindowProbe[]) => {
  for (const probe of probes) {
    statements = 0;
    bySql.clear();
    const response = await app.request(probe.path, headers(probe));
    const body = await response.text();
    const entries = response.ok ? (JSON.parse(body) as { entries?: unknown[] }).entries?.length ?? 0 : 0;
    console.log(`${probe.name.padEnd(30)} status=${response.status} statements=${statements} entries=${entries} bytes=${Buffer.byteLength(body)}`);
    if (verbose) for (const [sql, n] of [...bySql].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${sql}`);
  }
};
await read(sessionLogWindowProbes(fixture));
revealRunningTurnCard(db, fixture);
await read(sessionLogWindowRevealedProbes(fixture));
db.close();
