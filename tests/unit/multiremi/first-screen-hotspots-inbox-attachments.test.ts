// MUL-473 (S9-2, PR2): guards for `GET /api/inbox/summary` and
// `GET /api/attachments/:id/content`.
//
// Both routes were hotspots for the same reason the PR1 routes were: work
// proportional to the number of rows, not to the answer.
//
//   1. `/api/inbox/summary` walked every unarchived inbox row across the bridge
//      and de-duplicated/counted in JavaScript. It is now one aggregate plus a
//      read of the successful-run payloads. The golden below is compared
//      against a verbatim copy of the pre-change implementation running on the
//      same fixture, so attention rules and the autopilot date-group merge are
//      asserted against the old code, not against a restatement of the new one.
//   2. `/api/attachments/:id/content` re-sent the whole file on every request
//      with `Cache-Control: no-store`. It now streams with an `ETag` and an
//      immutable cache directive, and answers `304` when the client already has
//      the bytes.
import { afterEach, describe, expect, it } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { INBOX_LEDGER_TYPES } from "@multiremi/contracts";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { nullableString } from "@multiremi/store/helpers.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database.js";
import {
  seedFirstScreenHotspotsFixture,
  type FirstScreenHotspotsFixture,
} from "../../fixtures/multiremi/first-screen-hotspots-fixture.js";

let databases: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];
let uploadRoots: string[] = [];
const previousUploadDir = process.env.MULTIREMI_UPLOAD_DIR;

afterEach(async () => {
  for (const database of databases) await database.dispose();
  databases = [];
  for (const root of uploadRoots) rmSync(root, { recursive: true, force: true });
  uploadRoots = [];
  if (previousUploadDir === undefined) delete process.env.MULTIREMI_UPLOAD_DIR;
  else process.env.MULTIREMI_UPLOAD_DIR = previousUploadDir;
});

const AUTH_TOKEN = "mul473-inbox-token";

interface Probe {
  statements: number;
  bytes: number;
  rows: number;
  bySql: Map<string, number>;
  reset(): void;
}

function createProbe(): Probe {
  return {
    statements: 0,
    bytes: 0,
    rows: 0,
    bySql: new Map(),
    reset() {
      this.statements = 0;
      this.bytes = 0;
      this.rows = 0;
      this.bySql = new Map();
    },
  };
}

function countingDatabase(raw: SqlDatabase, probe: Probe): SqlDatabase {
  const record = (sql: string, rows: unknown[]): void => {
    probe.statements += 1;
    probe.rows += rows.length;
    if (rows.length) probe.bytes += JSON.stringify({ rows, count: rows.length }).length;
    const key = sql.replace(/\s+/g, " ").trim();
    probe.bySql.set(key, (probe.bySql.get(key) ?? 0) + 1);
  };
  const wrap = (statement: SqlStatement, sql: string): SqlStatement => new Proxy(statement, {
    get(target, property) {
      const value = target[property as keyof SqlStatement];
      if (["get", "all", "run", "values"].includes(String(property))) {
        return (...params: unknown[]) => {
          const result = (value as (...args: unknown[]) => unknown).apply(target, params);
          const rows = property === "get"
            ? (result == null ? [] : [result])
            : property === "values" || property === "all"
              ? (result as unknown[])
              : [];
          record(sql, rows);
          return result;
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const wrapped: SqlDatabase = {
    query: (sql) => wrap(raw.query(sql) as unknown as SqlStatement, sql),
    prepare: (sql) => wrap(raw.prepare(sql) as unknown as SqlStatement, sql),
    run(sql, ...params) {
      record(sql, []);
      const bindings = (params.length === 1 && Array.isArray(params[0]) ? params[0] : params) as SQLQueryBindings[];
      return raw.run(sql, bindings);
    },
    exec: (sql) => {
      record(sql, []);
      raw.exec(sql);
    },
    transaction: (fn) => raw.transaction(fn),
    close: () => raw.close(),
  };
  return new Proxy(raw, {
    get(target, property) {
      const source = property in wrapped ? wrapped : target;
      const value = Reflect.get(source, property);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

/**
 * Verbatim pre-MUL-473 `getInboxSummary` (parent commit `593ff2ba`), kept in the
 * test so the comparison is against the old rules rather than a restatement of
 * the new SQL. The `dateGroup` helper is copied from the same commit.
 */
function legacyDateGroup(createdAt: string, now: Date, timezoneOffsetMinutes: number): string {
  const localTimestamp = (value: Date) => value.getTime() - timezoneOffsetMinutes * 60_000;
  const shiftedNow = new Date(localTimestamp(now));
  const startToday = Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth(), shiftedNow.getUTCDate());
  const startYesterday = startToday - 86_400_000;
  const daySinceMonday = (shiftedNow.getUTCDay() + 6) % 7;
  const startWeek = startToday - daySinceMonday * 86_400_000;
  const timestamp = localTimestamp(new Date(createdAt));
  if (timestamp >= startToday) return "today";
  if (timestamp >= startYesterday) return "yesterday";
  if (timestamp >= startWeek) return "this_week";
  return "earlier";
}

function legacyInboxSummary(
  db: SqlDatabase,
  memberId: string,
  timezoneOffsetMinutes: number,
  workspaceId?: string,
): { unread: number; attention: number } {
  const workspaceFilter = workspaceId === undefined ? "" : " AND workspace_id = ?";
  const params = workspaceId === undefined ? [memberId] : [memberId, workspaceId];
  const rows = db.query(
    `SELECT id, issue_id, type, severity, read, created_at,
            CASE WHEN type = 'autopilot_run_completed' THEN details ELSE NULL END AS details
     FROM multiremi_inbox_items
     WHERE member_id = ?${workspaceFilter} AND archived = 0
     ORDER BY created_at DESC, id DESC`,
  ).all(...(params as never[])) as Array<Record<string, unknown>>;
  const visible: Array<Record<string, unknown>> = [];
  const selectionKeys = new Set<string>();
  for (const row of rows) {
    const issueId = nullableString(row.issue_id);
    const type = String(row.type);
    const key = (INBOX_LEDGER_TYPES as readonly string[]).includes(type) || !issueId
      ? `item:${row.id}`
      : `issue:${issueId}`;
    if (selectionKeys.has(key)) continue;
    selectionKeys.add(key);
    visible.push(row);
  }
  const attention = visible.filter((row) =>
    Number(row.read ?? 0) === 0
    && (row.severity === "attention" || row.severity === "action_required")).length;
  const now = new Date();
  const mergedSuccessfulRuns = new Map<string, { unread: boolean }>();
  let unread = 0;
  for (const row of visible) {
    const isUnread = Number(row.read ?? 0) === 0;
    const details = row.type === "autopilot_run_completed" && typeof row.details === "string"
      ? JSON.parse(row.details) as Record<string, unknown> | null
      : null;
    const autopilotId = typeof details?.autopilot_id === "string" ? details.autopilot_id : null;
    if (!autopilotId) {
      if (isUnread) unread += 1;
      continue;
    }
    const mergeKey = `${legacyDateGroup(String(row.created_at), now, timezoneOffsetMinutes)}:${autopilotId}`;
    const merged = mergedSuccessfulRuns.get(mergeKey);
    if (merged) merged.unread ||= isUnread;
    else mergedSuccessfulRuns.set(mergeKey, { unread: isUnread });
  }
  unread += [...mergedSuccessfulRuns.values()].filter((entry) => entry.unread).length;
  return { unread, attention };
}

interface Harness {
  store: MultiremiStore;
  db: SqlDatabase;
  probe: Probe;
  app: ReturnType<typeof createMultiremiApp>;
  fixture: FirstScreenHotspotsFixture;
  headers: Record<string, string>;
}

async function createHarness(options: Parameters<typeof seedFirstScreenHotspotsFixture>[1] = {}): Promise<Harness> {
  const database = await openHotspotDatabase();
  databases.push(database);
  const db = database.db;
  const probe = createProbe();
  const store = new MultiremiStore(countingDatabase(db, probe));
  const fixture = seedFirstScreenHotspotsFixture(store, {
    ...options,
    run: (sql, params) => { db.run(sql, params as SQLQueryBindings[]); },
  });
  const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
  const credential = await store.createAccessToken({
    name: "MUL-473 inbox test",
    type: "pat",
    userId: fixture.readerUserId,
    workspaceId: fixture.workspaceId,
    purpose: "session",
  });
  return {
    store,
    db,
    probe,
    app,
    fixture,
    headers: {
      Authorization: `Bearer ${credential.token}`,
      "X-Workspace-ID": fixture.workspaceId,
    },
  };
}

async function getInboxSummary(
  harness: Harness,
  timezoneOffset: number,
): Promise<{ body: { unread: number; attention: number }; statements: number; bytes: number }> {
  harness.probe.reset();
  const response = await harness.app.request(`/api/inbox/summary?timezone_offset=${timezoneOffset}`, {
    headers: harness.headers,
  });
  const text = await response.text();
  const statements = harness.probe.statements;
  const bytes = harness.probe.bytes;
  if (response.status !== 200) throw new Error(`inbox summary: HTTP ${response.status} ${text.slice(0, 300)}`);
  return { body: JSON.parse(text) as { unread: number; attention: number }, statements, bytes };
}

describe("MUL-473 inbox summary", () => {
  it("matches the pre-change implementation on the same fixture, across timezones", async () => {
    const harness = await createHarness();
    for (const timezoneOffset of [0, 480, -300, 840]) {
      const expected = legacyInboxSummary(harness.db, harness.fixture.readerMemberId, timezoneOffset, harness.fixture.workspaceId);
      const actual = await getInboxSummary(harness, timezoneOffset);
      expect(actual.body).toEqual(expected);
      // The fixture's own declared counts are the third witness.
      expect(actual.body.attention).toBeGreaterThan(0);
      expect(actual.body.unread).toBeGreaterThan(0);
    }
  }, 20000);

  it("matches the pre-change implementation on a random mix of inbox shapes", async () => {
    let state = 0x473b_ee;
    const random = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state |= 0;
      return (state >>> 8) & 0xffff;
    };
    const types = [
      "autopilot_run_completed",
      "autopilot_run_failed",
      "autopilot_paused",
      "issue_assigned",
      "issue_comment",
      "comment_mention",
      "feishu_ingest_connection_alert",
    ];
    const severities = ["info", "attention", "action_required"];
    const harness = await createHarness({ sessions: 1, agents: 1, issues: 4, inboxRows: 0 });
    const { fixture } = harness;
    const base = Date.UTC(2026, 8, 20, 12, 0, 0);
    harness.db.run("DELETE FROM multiremi_inbox_items");
    for (let index = 0; index < 180; index += 1) {
      const createdAt = new Date(base - (random() % 20) * 86_400_000 - (random() % 5) * 3_600_000).toISOString();
      const type = types[random() % types.length]!;
      const details = random() % 4 === 0 ? null : JSON.stringify({ autopilot_id: `atp_${random() % 3}` });
      harness.db.run(
        `INSERT INTO multiremi_inbox_items (
           id, workspace_id, issue_id, member_id, recipient_type, recipient_id,
           severity, actor_type, actor_id, type, title, body, details, read, archived, created_at
         ) VALUES (?, ?, ?, ?, 'member', ?, ?, 'system', NULL, ?, 't', 'b', ?, ?, 0, ?)`,
        [
          `inb_random_${index}`,
          fixture.workspaceId,
          random() % 9 === 0 ? null : fixture.issueIds[random() % fixture.issueIds.length]!,
          fixture.readerMemberId,
          fixture.readerMemberId,
          severities[random() % 3]!,
          type,
          details,
          random() % 3 === 0 ? 1 : 0,
          createdAt,
        ] as never[],
      );
    }
    for (const timezoneOffset of [0, 480, 840]) {
      expect((await getInboxSummary(harness, timezoneOffset)).body)
        .toEqual(legacyInboxSummary(harness.db, fixture.readerMemberId, timezoneOffset, fixture.workspaceId));
    }
    // Archived rows must not be counted (the old query filtered them too).
    harness.db.run("UPDATE multiremi_inbox_items SET archived = 1");
    expect((await getInboxSummary(harness, 0)).body).toEqual({ unread: 0, attention: 0 });
  }, 20000);

  it("keeps the bridge payload proportional to the completed runs, not to the inbox", async () => {
    const measurements: Array<{ inboxRows: number; statements: number; bytes: number }> = [];
    for (const inboxRows of [50, 300, 900]) {
      const harness = await createHarness({ sessions: 1, agents: 1, inboxRows });
      const summary = await getInboxSummary(harness, 0);
      expect(summary.body).toEqual(
        legacyInboxSummary(harness.db, harness.fixture.readerMemberId, 0, harness.fixture.workspaceId),
      );
      measurements.push({ inboxRows, statements: summary.statements, bytes: summary.bytes });
    }
    // Auth (token read + `last_used_at` + membership), the aggregate, and the
    // completed-run payload read: a constant that never sees the row count.
    for (const point of measurements) expect(point.statements).toBeLessThanOrEqual(8);
    expect(measurements[0]!.statements).toBe(measurements[2]!.statements);
    // One fifth of the fixture's rows are successful runs, so dbb grows with
    // those rows alone; the pre-change route moved every row. The issue's budget
    // is dbb < 100 KB, which the whole fixture must stay under.
    for (const point of measurements) expect(point.bytes).toBeLessThan(100 * 1024);
    const perRow = measurements.map((point) => point.bytes / point.inboxRows);
    expect(perRow[2]!).toBeLessThan(perRow[0]! * 2);
  }, 20000);
});

describe("MUL-473 attachment content caching", () => {
  async function seedAttachment(harness: Harness, sizeBytes = 512): Promise<{ id: string; bytes: Buffer }> {
    const root = mkdtempSync(join(tmpdir(), "mul473-uploads-"));
    uploadRoots.push(root);
    process.env.MULTIREMI_UPLOAD_DIR = root;
    const attachment = harness.store.createAttachment({
      id: "att_mul473_fixture",
      workspaceId: harness.fixture.workspaceId,
      issueId: harness.fixture.issueIds[0]!,
      uploaderType: "member",
      uploaderId: harness.fixture.readerUserId,
      filename: "hotspot.bin",
      url: "/api/attachments/att_mul473_fixture/content",
      contentType: "application/octet-stream",
      sizeBytes,
    });
    const path = join(root, harness.fixture.workspaceId, `att_mul473_fixture.bin`);
    mkdirSync(dirname(path), { recursive: true });
    const bytes = Buffer.alloc(sizeBytes, 7);
    writeFileSync(path, bytes);
    return { id: attachment.id, bytes };
  }

  it("serves the bytes with an immutable ETag and a stable Content-Disposition", async () => {
    const harness = await createHarness({ sessions: 1, agents: 1, issues: 2, inboxRows: 0 });
    const seeded = await seedAttachment(harness, 2048);
    const response = await harness.app.request(`/api/attachments/${seeded.id}/content`, { headers: harness.headers });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(seeded.bytes)).toBe(true);
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBe('"att_mul473_fixture"');
    expect(response.headers.get("vary")?.toLowerCase()).toContain("authorization");
    expect(response.headers.get("vary")?.toLowerCase()).toContain("cookie");
    expect(response.headers.get("content-disposition")).toStartWith('attachment; filename="hotspot.bin"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // The immutable id is the content version; reads do not change it.
    const second = await harness.app.request(`/api/attachments/${seeded.id}/content`, { headers: harness.headers });
    expect(second.headers.get("etag")).toBe(response.headers.get("etag"));
  }, 20000);

  it("answers 304 with no body when If-None-Match matches", async () => {
    const harness = await createHarness({ sessions: 1, agents: 1, issues: 2, inboxRows: 0 });
    const seeded = await seedAttachment(harness);
    const first = await harness.app.request(`/api/attachments/${seeded.id}/content`, { headers: harness.headers });
    const etag = first.headers.get("etag")!;

    const revalidated = await harness.app.request(`/api/attachments/${seeded.id}/content`, {
      headers: { ...harness.headers, "If-None-Match": etag },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(revalidated.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(revalidated.headers.get("vary")).toBe(first.headers.get("vary"));
    expect(revalidated.headers.get("content-disposition")).toStartWith('attachment; filename="hotspot.bin"');

    // A weak validator and a list entry both match, per RFC 9110.
    for (const header of [`W/${etag}`, `"other", ${etag}`]) {
      const weak = await harness.app.request(`/api/attachments/${seeded.id}/content`, {
        headers: { ...harness.headers, "If-None-Match": header },
      });
      expect(weak.status).toBe(304);
    }
    // A stale validator gets the bytes again.
    const stale = await harness.app.request(`/api/attachments/${seeded.id}/content`, {
      headers: { ...harness.headers, "If-None-Match": '"att_other-1-1"' },
    });
    expect(stale.status).toBe(200);
    expect((await stale.arrayBuffer()).byteLength).toBe(seeded.bytes.length);
  }, 20000);

  it("keeps the download route's Content-Disposition and caching identical", async () => {
    const harness = await createHarness({ sessions: 1, agents: 1, issues: 2, inboxRows: 0 });
    const seeded = await seedAttachment(harness);
    const response = await harness.app.request(`/api/attachments/${seeded.id}/download`, { headers: harness.headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toStartWith("attachment;");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
  }, 20000);

  it("still 404s for a missing file and an unknown attachment", async () => {
    const harness = await createHarness({ sessions: 1, agents: 1, issues: 2, inboxRows: 0 });
    const root = mkdtempSync(join(tmpdir(), "mul473-uploads-"));
    uploadRoots.push(root);
    process.env.MULTIREMI_UPLOAD_DIR = root;
    harness.store.createAttachment({
      id: "att_mul473_missing",
      workspaceId: harness.fixture.workspaceId,
      issueId: harness.fixture.issueIds[0]!,
      uploaderType: "member",
      uploaderId: harness.fixture.readerUserId,
      filename: "gone.bin",
      url: "/api/attachments/att_mul473_missing/content",
      contentType: "application/octet-stream",
      sizeBytes: 1,
    });
    const missing = await harness.app.request("/api/attachments/att_mul473_missing/content", { headers: harness.headers });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "attachment file not found" });
    const unknown = await harness.app.request("/api/attachments/att_nope/content", { headers: harness.headers });
    expect(unknown.status).toBe(404);
  }, 20000);
});
