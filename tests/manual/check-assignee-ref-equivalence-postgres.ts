#!/usr/bin/env bun
/**
 * MUL-473 (S9-2, PR1 QA rework): the assignee-reference equivalence table on a
 * real PostgreSQL backend.
 *
 * `first-screen-hotspots-assignee-ref.test.ts` runs the same table on in-memory
 * SQLite. The resolver's behaviour is backend-independent by construction, but
 * the *reads* are not: `listAgentsLite` / `listWorkspaceMembers` / `listSquads`
 * go through `translateSqliteToPg`, and an `IN (…)`/`ORDER BY` difference there
 * would change which row wins a tier. This script re-runs every golden case
 * against `PostgresSyncDatabase` and compares it to the same golden that was
 * captured from the pre-PR implementation on SQLite.
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://… \
 *     bun run tests/manual/check-assignee-ref-equivalence-postgres.ts
 *
 * Exits non-zero on the first difference, and always drops the scratch database
 * it created.
 */
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { assigneeRefCases, installAssigneeRefIds, seedAssigneeRefFixture } from "../fixtures/multiremi/assignee-ref-fixture.js";
import golden from "../fixtures/multiremi/assignee-ref-golden.json";

const ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL?.trim() ?? "";
if (!ADMIN_URL) {
  console.error("MULTIREMI_TEST_POSTGRES_URL is required: this check is the PostgreSQL half of the equivalence evidence");
  process.exit(2);
}

type GoldenCase = {
  label: string;
  ref: string;
  store: { assigneeType?: string; assigneeId?: string; error?: string };
  http: { status: number; total: number | null; issueIds: string[] | null };
};
const cases = golden.cases as GoldenCase[];

const dbName = `multiremi_mul473_ref_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const admin = new Bun.SQL(ADMIN_URL, { max: 1 });
await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${dbName}`);
await admin.end();
const url = new URL(ADMIN_URL);
url.pathname = `/${dbName}`;
const db = new PostgresSyncDatabase(url.toString());

let failures = 0;
let checked = 0;
try {
  const store = new MultiremiStore(db);
  const restoreIds = installAssigneeRefIds();
  let fixture;
  try {
    fixture = seedAssigneeRefFixture(store);
  } finally {
    restoreIds();
  }
  const app = createMultiremiApp({ store, authToken: "mul473-ref-pg" });
  const credential = await store.createAccessToken({
    name: "MUL-473 ref equivalence (PG)",
    type: "pat",
    userId: fixture.readerUserId,
    workspaceId: fixture.workspaceId,
    purpose: "session",
  });
  const headers = { Authorization: `Bearer ${credential.token}`, "X-Workspace-ID": fixture.workspaceId };
  const table = assigneeRefCases(fixture);
  if (table.length !== cases.length) throw new Error(`case table drift: ${table.length} vs golden ${cases.length}`);

  for (const [index, testCase] of table.entries()) {
    const expected = cases[index]!;
    if (testCase.label !== expected.label || testCase.ref !== expected.ref) {
      throw new Error(`case ${index} drift: ${testCase.label}/${testCase.ref} vs ${expected.label}/${expected.ref}`);
    }
    let actualStore: GoldenCase["store"];
    try {
      const resolved = store.resolveAssigneeRef(null, testCase.ref, fixture.workspaceId);
      actualStore = resolved ? { assigneeType: resolved.assigneeType, assigneeId: resolved.assigneeId } : { error: "<null>" };
    } catch (error) {
      actualStore = { error: error instanceof Error ? error.message : String(error) };
    }
    const response = await app.request(`/api/issues?assignee_id=${encodeURIComponent(testCase.ref)}&limit=50`, { headers });
    const body = response.status === 200
      ? await response.json() as { total: number; issues: Array<{ id: string }> }
      : null;
    const actualHttp = body
      ? { status: 200, total: body.total, issueIds: body.issues.map((issue) => issue.id) }
      : { status: response.status, total: null, issueIds: null };

    checked += 1;
    const storeOk = JSON.stringify(actualStore) === JSON.stringify(expected.store);
    const httpOk = JSON.stringify(actualHttp) === JSON.stringify(expected.http);
    if (!storeOk || !httpOk) {
      failures += 1;
      console.error(`DIFF ${testCase.label} (ref=${JSON.stringify(testCase.ref)})`);
      if (!storeOk) console.error(`  store: expected ${JSON.stringify(expected.store)} got ${JSON.stringify(actualStore)}`);
      if (!httpOk) console.error(`  http:  expected ${JSON.stringify(expected.http)} got ${JSON.stringify(actualHttp)}`);
    }
  }
  console.log(`checked ${checked} cases against PostgreSQL ${dbName}`);
  console.log(failures === 0 ? "ALL MATCH the 593ff2ba golden" : `${failures} DIFFERENCES`);
} finally {
  db.close();
  const cleanup = new Bun.SQL(ADMIN_URL, { max: 1 });
  await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await cleanup.end();
}
if (failures > 0) process.exit(1);
