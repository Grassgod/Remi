#!/usr/bin/env bun
/**
 * MUL-473: capture the first-screen hotspot response golden.
 *
 * Run this on the commit whose responses are the contract — the harness is
 * implementation-agnostic, so running it here and on the optimized route
 * produces the same bytes whenever the response shape did not drift:
 *
 *   bun run tests/fixtures/multiremi/capture-first-screen-hotspots-golden.ts [--out <path>]
 *
 * The golden records only the routes PR1 touches. `GET /api/inbox/summary` and
 * `GET /api/attachments/:id/content` are captured by their own PR2 files.
 */
import { Database } from "bun:sqlite";
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
  const db = new Database(":memory:");
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
  const golden = await captureFirstScreenHotspotGolden(
    args.includes("--baseline")
      ? "pre-optimization implementation (parent commit of agent/MUL-473)"
      : "current implementation",
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
