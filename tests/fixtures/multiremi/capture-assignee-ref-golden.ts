#!/usr/bin/env bun
/**
 * MUL-473: capture the assignee-reference resolution golden.
 *
 * Run this on the commit whose behaviour is the contract — the harness is
 * implementation-agnostic, so running it here and on the fixed resolver records
 * whatever the checked-out code actually does.
 *
 * To reproduce the checked-in `assignee-ref-golden.json` byte for byte, run the
 * following on `593ff2ba` (the pre-MUL-473 implementation) after copying this
 * script and `assignee-ref-fixture.ts` there unchanged:
 *
 *   bun run tests/fixtures/multiremi/capture-assignee-ref-golden.ts \
 *     --baseline --out tests/fixtures/multiremi/assignee-ref-golden.json
 *
 * `--baseline` writes the `pre-MUL-473 implementation (593ff2ba)` source label
 * the checked-in file carries, so no post-processing is needed. Use
 * `--source <label>` instead when capturing some other tree, so the golden
 * always names the implementation its values came from.
 *
 * Each case records the store-level answer (or the error message) *and* the
 * HTTP-level `GET /api/issues?assignee_id=…` answer, because the route's `total`
 * and id list are what a regression in this resolver actually breaks.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { assigneeRefCases, installAssigneeRefIds, seedAssigneeRefFixture } from "./assignee-ref-fixture.js";

const DEFAULT_OUT = join(import.meta.dir, "assignee-ref-golden.json");
const AUTH_TOKEN = "mul473-assignee-ref-token";

export interface AssigneeRefGoldenCase {
  label: string;
  ref: string;
  /** `{assigneeType, assigneeId}`, or `{error}` when the resolver threw. */
  store: { assigneeType?: string; assigneeId?: string; error?: string };
  /** `GET /api/issues?assignee_id=<ref>`: status, total and issue ids. */
  http: { status: number; total: number | null; issueIds: string[] | null; error?: string };
}

export interface AssigneeRefGolden {
  name: string;
  capturedAt: string;
  source: string;
  cases: AssigneeRefGoldenCase[];
}

export async function captureAssigneeRefGolden(source: string): Promise<AssigneeRefGolden> {
  const restoreIds = installAssigneeRefIds();
  const db = new Database(":memory:");
  try {
    const store = new MultiremiStore(db);
    const fixture = seedAssigneeRefFixture(store);
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const credential = await store.createAccessToken({
      name: "MUL-473 assignee ref golden",
      type: "pat",
      userId: fixture.readerUserId,
      workspaceId: fixture.workspaceId,
      purpose: "session",
    });
    const headers = {
      Authorization: `Bearer ${credential.token}`,
      "X-Workspace-ID": fixture.workspaceId,
    };

    const cases: AssigneeRefGoldenCase[] = [];
    for (const testCase of assigneeRefCases(fixture)) {
      let storeResult: AssigneeRefGoldenCase["store"];
      try {
        const resolved = store.resolveAssigneeRef(null, testCase.ref, fixture.workspaceId);
        storeResult = resolved
          ? { assigneeType: resolved.assigneeType, assigneeId: resolved.assigneeId }
          : { error: "<null>" };
      } catch (error) {
        storeResult = { error: error instanceof Error ? error.message : String(error) };
      }

      let httpResult: AssigneeRefGoldenCase["http"];
      const response = await app.request(`/api/issues?assignee_id=${encodeURIComponent(testCase.ref)}&limit=50`, { headers });
      const text = await response.text();
      if (response.status === 200) {
        const body = JSON.parse(text) as { total: number; issues: Array<{ id: string }> };
        httpResult = { status: 200, total: body.total, issueIds: body.issues.map((issue) => issue.id) };
      } else {
        httpResult = { status: response.status, total: null, issueIds: null, error: text.slice(0, 200) };
      }

      cases.push({ label: testCase.label, ref: testCase.ref, store: storeResult, http: httpResult });
    }

    return {
      name: "MUL-473 assignee reference resolution",
      capturedAt: "<timestamp>",
      source,
      cases,
    };
  } finally {
    restoreIds();
    db.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1]! : DEFAULT_OUT;
  const sourceIndex = args.indexOf("--source");
  const explicitSource = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
  const golden = await captureAssigneeRefGolden(
    explicitSource
      ?? (args.includes("--baseline")
        ? "pre-MUL-473 implementation (593ff2ba)"
        : "current implementation"),
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote ${outPath} (${golden.cases.length} cases)`);
  for (const testCase of golden.cases) {
    const store = testCase.store.error ? `error=${testCase.store.error}` : `${testCase.store.assigneeType}:${testCase.store.assigneeId}`;
    console.log(
      `${testCase.label.padEnd(52)} store=${store.padEnd(46)} http=${testCase.http.status} total=${testCase.http.total} ids=[${(testCase.http.issueIds ?? []).join(",")}]`,
    );
  }
}
