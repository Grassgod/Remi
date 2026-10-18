#!/usr/bin/env bun
/**
 * Capture the session log window response golden.
 *
 * Run on the commit whose responses are the contract. The harness only uses
 * routes and production store writers, so running it before and after an
 * implementation change produces the same bytes whenever the responses did not
 * drift:
 *
 *   bun run tests/fixtures/multiremi/capture-session-log-window-golden.ts
 *
 * `tests/unit/multiremi/session-log-window-query-count.test.ts` reads
 * `session-log-window-golden.json` and requires every body to be byte-identical
 * (`JSON.stringify` of the stored body is the route's `c.json` output).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { installDeterministicIds } from "./issue-detail-first-screen-fixture.js";
import { readSessionLogWindowResponses, seedSessionLogWindowFixture } from "./session-log-window-fixture.js";

const OUT_PATH = join(import.meta.dir, "session-log-window-golden.json");
const source = process.argv[2] ?? "unspecified commit";

const db = openSqliteDatabase(":memory:") as unknown as SqlDatabase;
const store = new MultiremiStore(db);
// Pin ids and the clock after migration, so schema changes do not shift them.
const restoreIds = installDeterministicIds();
try {
  const app = createMultiremiApp({ store, authToken: "session-log-window-master" });
  const fixture = await seedSessionLogWindowFixture(store);
  const responses = await readSessionLogWindowResponses((path, init) => app.request(path, init), db, fixture);
  const golden = {
    name: "Session log window responses",
    source,
    probes: responses.map(response => ({
      name: response.name,
      path: response.path,
      status: response.status,
      bytes: Buffer.byteLength(response.body, "utf8"),
      body: JSON.parse(response.body) as unknown,
    })),
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(golden, null, 1)}\n`);
  for (const probe of golden.probes) console.log(`${probe.name}: ${probe.status} ${probe.bytes} bytes`);
  console.log(`wrote ${OUT_PATH}`);
} finally {
  restoreIds();
  db.close();
}
