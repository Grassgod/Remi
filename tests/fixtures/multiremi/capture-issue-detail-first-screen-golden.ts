#!/usr/bin/env bun
/**
 * MUL-385: capture the Issue detail first-screen response golden.
 *
 * Run this on the commit whose responses are the contract — the harness is
 * intentionally implementation-agnostic, so running it here and on the fix
 * produces the same bytes whenever the response shape did not drift:
 *
 *   bun run tests/fixtures/multiremi/capture-issue-detail-first-screen-golden.ts
 *
 * The unit test `issue-detail-first-screen-query-count.test.ts` reads
 * `issue-detail-first-screen-golden.json` and fails on any difference.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  installDeterministicIds,
  normalizeIssueDetailResponse,
  seedIssueDetailFirstScreenFixture,
} from "./issue-detail-first-screen-fixture.js";

const OUT_PATH = join(import.meta.dir, "issue-detail-first-screen-golden.json");
const AUTH_TOKEN = "mul385-first-screen-token";
const AUTH_HEADERS = { Authorization: `Bearer ${AUTH_TOKEN}` };

/** Bind the fixture's pinned `joined_at` writes without tripping the binder types. */
function runPinned(db: Database, sql: string, params: unknown[]): void {
  db.run(sql, params as SQLQueryBindings[]);
}

const restoreIds = installDeterministicIds();
const db = new Database(":memory:");
try {
  const store = new MultiremiStore(db);
  const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
  const fixture = seedIssueDetailFirstScreenFixture(store, {
    run: (sql, params) => { runPinned(db, sql, params); },
  });

  const issueDetail = await (await app.request(`/api/issues/${fixture.issueId}`, { headers: AUTH_HEADERS })).json();
  const sessions = await (await app.request(`/api/issues/${fixture.issueId}/sessions`, { headers: AUTH_HEADERS })).json();
  const timeline = await (await app.request(
    `/api/issues/${fixture.issueId}/timeline?issue_session_id=%40default&limit=40`,
    { headers: AUTH_HEADERS },
  )).json();

  const golden = {
    name: "MUL-385 issue detail first-screen responses",
    capturedAt: "<timestamp>",
    source: "pre-optimization implementation (parent commit of agent/MUL-385)",
    fixture: {
      issueId: fixture.issueId,
      issueKey: fixture.issueKey,
      counts: fixture.counts,
    },
    issueDetail: normalizeIssueDetailResponse(issueDetail),
    sessions: normalizeIssueDetailResponse(sessions),
    timeline: normalizeIssueDetailResponse(timeline),
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote ${OUT_PATH}`);
  console.log(`issue=${fixture.issueId} comments=${fixture.counts.comments} sessions=${fixture.counts.sessions} tasks=${fixture.counts.tasks}`);
} finally {
  restoreIds();
  db.close();
}
