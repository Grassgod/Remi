#!/usr/bin/env bun
/**
 * MUL-473: capture the first-screen hotspot response golden.
 *
 * Run this on the commit whose responses are the contract — the harness is
 * implementation-agnostic, so running it here on the optimized route produces
 * the same bytes whenever the response shape did not drift.
 *
 * Reproduce the checked-in `first-screen-hotspots-golden.json` byte for byte by
 * running this on the merge state (`620fc94f`) or anywhere later on this branch,
 * with the fixture and `first-screen-hotspots-normalize.ts` from the same
 * revision:
 *
 *   bun run tests/fixtures/multiremi/capture-first-screen-hotspots-golden.ts \
 *     --baseline --out tests/fixtures/multiremi/first-screen-hotspots-golden.json
 *
 * The response bodies are the contract of the pre-optimization implementation,
 * but they are recorded *after* merging main, so each issue carries the
 * `parent_done_grant_at/by/agent_id` fields MUL-457 added to the response. The
 * capture therefore has to happen on the merge state, not on the pre-MUL-473
 * commit on its own: that commit's responses predate those three fields.
 * `--source <label>` overrides the header label when capturing anywhere else.
 *
 * The golden records only the routes PR1 touches. `GET /api/inbox/summary` and
 * `GET /api/attachments/:id/content` are captured by their own PR2 files.
 */
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  installFirstScreenHotspotIds,
  normalizeFirstScreenHotspotResponse,
} from "./first-screen-hotspots-normalize.js";
import { seedFirstScreenHotspotsFixture, type FirstScreenHotspotsFixture } from "./first-screen-hotspots-fixture.js";

const DEFAULT_OUT = join(import.meta.dir, "first-screen-hotspots-golden.json");
const AUTH_TOKEN = "mul473-hotspot-token";

/**
 * The response contract this file records predates the optimization, so the
 * label names that implementation rather than a capture date or a commit of the
 * branch being reviewed. Re-running the capture on any later main yields the
 * same bytes, because the routes' response shape did not drift.
 */
const FIRST_SCREEN_GOLDEN_SOURCE =
  "pre-optimization implementation (593ff2ba) re-captured after merging origin/main d6714966 "
  + "(MUL-457 added the parent_done_grant_* fields)";

export interface FirstScreenHotspotGolden {
  name: string;
  capturedAt: string;
  source: string;
  fixture: {
    sessions: number;
    agents: number;
    inboxRows: number;
    issues: number;
    skillBodyBytes: number;
  };
  chatPendingTasks: unknown;
  issuesMyAssignee: unknown;
  issuesByMemberRowId: unknown;
  issuesByAgentName: unknown;
}

export async function captureFirstScreenHotspotGolden(source: string): Promise<FirstScreenHotspotGolden> {
  const restoreIds = installFirstScreenHotspotIds();
  const db = openSqliteDatabase(":memory:");
  try {
    const store = new MultiremiStore(db);
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    // The fixture pins timestamps through raw SQL; the counting store is not
    // needed here because this capture only records response bytes.
    const fixture: FirstScreenHotspotsFixture = seedFirstScreenHotspotsFixture(store, {
      run: (sql, params) => { db.run(sql, ...(params as never[])); },
    });
    const credential = await store.createAccessToken({
      name: "MUL-473 hotspot golden",
      type: "pat",
      userId: fixture.readerUserId,
      workspaceId: fixture.workspaceId,
      purpose: "session",
    });
    const headers = {
      Authorization: `Bearer ${credential.token}`,
      "X-Workspace-ID": fixture.workspaceId,
    };
    const get = async (path: string): Promise<unknown> => {
      const response = await app.request(path, { headers });
      const text = await response.text();
      if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
      return JSON.parse(text) as unknown;
    };
    return {
      name: "MUL-473 first-screen hotspot responses",
      capturedAt: "<timestamp>",
      source,
      fixture: {
        sessions: fixture.counts.sessions,
        agents: fixture.counts.agents,
        inboxRows: fixture.counts.inboxRows,
        issues: fixture.counts.issues,
        skillBodyBytes: fixture.counts.skillBodyBytes,
      },
      chatPendingTasks: normalizeFirstScreenHotspotResponse(
        await get("/api/chat/pending-tasks"),
        fixture,
      ),
      issuesMyAssignee: normalizeFirstScreenHotspotResponse(
        await get(`/api/issues?assignee_id=${fixture.readerUserId}&limit=50`),
        fixture,
      ),
      issuesByMemberRowId: normalizeFirstScreenHotspotResponse(
        await get(`/api/issues?assignee_id=${fixture.readerMemberId}&limit=50`),
        fixture,
      ),
      issuesByAgentName: normalizeFirstScreenHotspotResponse(
        await get(`/api/issues?assignee_id=${encodeURIComponent("Hotspot agent 5")}&limit=50`),
        fixture,
      ),
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
  const golden = await captureFirstScreenHotspotGolden(
    explicitSource
      ?? (args.includes("--baseline") ? FIRST_SCREEN_GOLDEN_SOURCE : "current implementation"),
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
  console.log(`pending-tasks: ${(golden.chatPendingTasks as { tasks: unknown[] }).tasks.length} tasks`);
  for (const key of ["issuesMyAssignee", "issuesByMemberRowId", "issuesByAgentName"] as const) {
    const body = golden[key] as { issues: unknown[]; total: number };
    console.log(`${key}: ${body.issues.length} issues, total=${body.total}`);
  }
}
