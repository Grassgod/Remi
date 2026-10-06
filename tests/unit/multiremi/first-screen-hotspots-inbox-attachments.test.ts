// MUL-473 (S9-2, PR2): guards for canonical `GET /api/inbox` counts and
// `GET /api/attachments/:id/content`.
//
// Both routes were hotspots for the same reason the PR1 routes were: work
// proportional to the number of rows, not to the answer.
//
//   1. Canonical inbox counts aggregate the unread message log independently
//      of the paginated payload. Retired notification timezone folds do not
//      participate in unread or attention counts.
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
import { readProcessDbCounters } from "@multiremi/observability/request-metrics.js";
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
    probe.bytes += Buffer.byteLength(JSON.stringify({ rows, count: rows.length }), "utf8");
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
  const beforeBytes = readProcessDbCounters().dbBytes;
  const response = await harness.app.request("/api/inbox"+`?timezone_offset=${timezoneOffset}`, {
    headers: harness.headers,
  });
  const text = await response.text();
  const statements = harness.probe.statements;
  // PG counts the actual bridge frames, including empty replies and command metadata.
  const bytes = harness.db.dialect === "postgres"
    ? readProcessDbCounters().dbBytes - beforeBytes
    : harness.probe.bytes;
  expect(bytes).toBeGreaterThan(0);
  if (response.status !== 200) throw new Error(`inbox summary: HTTP ${response.status} ${text.slice(0, 300)}`);
  const page = JSON.parse(text) as { unread_count: number; attention_count: number };
  return { body: { unread: page.unread_count, attention: page.attention_count }, statements, bytes };
}

describe("MUL-473 inbox summary", () => {
  it("counts canonical messages independently of the retired timezone folds", async () => {
    const harness=await createHarness();
    const expected={unread:harness.fixture.counts.inboxUnread,attention:harness.fixture.counts.inboxAttention};
    expect((await getInboxSummary(harness,0)).body).toEqual(expected);
    expect(expected.unread).toBe(300);expect(expected.attention).toBe(120);
    // Resolving work removes attention, while reading removes the message.
    const session=harness.store.getOrCreateDefaultIssueSession(harness.fixture.issueIds[0]!).id;
    harness.store.resolveMessage('msg_hotspot_1',{type:'member',id:harness.fixture.readerMemberId});
    expect((await getInboxSummary(harness,0)).body).toEqual({unread:300,attention:119});
    const read=await harness.app.request('/api/inbox/read',{method:'POST',headers:{...harness.headers,'Content-Type':'application/json'},body:JSON.stringify({session_id:session})});
    expect(read.status).toBe(200);
    expect((await getInboxSummary(harness,0)).body).toEqual({unread:0,attention:0});
  },20000);

  it("bounds canonical inbox hydration at every scale", async () => {
    const harness = await createHarness({ sessions: 1, agents: 1, inboxRows: 900 });
    // Each scale measures the first authenticated request, including its
    // last-used stamp, just as the former independent fixtures did.
    const credentials = await Promise.all([50, 300, 900].map(inboxRows => harness.store.createAccessToken({
      name: `Inbox scale ${inboxRows}`, type: "pat", userId: harness.fixture.readerUserId,
      workspaceId: harness.fixture.workspaceId, purpose: "session",
    })));
    const session = harness.store.getOrCreateDefaultIssueSession(harness.fixture.issueIds[0]!).id;
    const firstSeq = Number((harness.db.query(`SELECT MIN(seq) AS seq FROM multiremi_conversation_log
      WHERE session_id=? AND to_member_id=?`).get(session, harness.fixture.readerMemberId) as { seq: number | string }).seq);
    const measurements: Array<{ inboxRows: number; statements: number; bytes: number }> = [];
    // Vary the visible population in one fixture; database bootstrap is not
    // part of the measured route's query or bridge-byte budget.
    for (const inboxRows of [50, 300, 900]) {
      harness.headers.Authorization = `Bearer ${credentials[measurements.length]!.token}`;
      harness.db.run(`UPDATE multiremi_conversation_log SET visibility=CASE WHEN seq<? THEN 'shown' ELSE 'hidden' END
        WHERE session_id=? AND to_member_id=?`, firstSeq + inboxRows, session, harness.fixture.readerMemberId);
      const summary = await getInboxSummary(harness, 0);
      expect(summary.body).toEqual(
        {unread:inboxRows,attention:inboxRows / 5 * 2},
      );
      measurements.push({ inboxRows, statements: summary.statements, bytes: summary.bytes });
    }
    // Auth, inbox aggregates, and one payload page stay within a constant
    // statement budget regardless of the unread population.
    for (const point of measurements) expect(point.statements).toBeLessThanOrEqual(8);
    expect(measurements[0]!.statements).toBe(measurements[2]!.statements);
    // The payload page caps bridge bytes while counts cover the full population.
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
