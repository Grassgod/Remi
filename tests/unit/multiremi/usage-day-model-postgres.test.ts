import { afterAll, beforeAll, describe, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { assertDayModelPagination, assertDefaultDetailPage } from "./usage-day-model-cases.js";
const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const databaseName = `usage_day_model_${randomUUID().replaceAll("-", "")}`;
let admin: Bun.SQL | undefined, db: PostgresSyncDatabase | undefined, created = false, store: MultiremiStore;
describe.skipIf(!adminUrl)("date × model PostgreSQL projection", () => {
  beforeAll(async () => {
    if (!adminUrl || !/^usage_day_model_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Invalid isolated fixture");
    admin = new Bun.SQL(adminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`); created = true;
    const url = new URL(adminUrl); url.pathname = `/${databaseName}`;
    db = new PostgresSyncDatabase(url.toString()); store = new MultiremiStore(db); store.ensureLocalWorkspace();
  }, 30_000);
  afterAll(async () => {
    db?.close();
    try { if (admin && created && /^usage_day_model_[a-f0-9]{32}$/.test(databaseName)) await admin.unsafe(`DROP DATABASE ${databaseName}`); }
    finally { await admin?.end(); }
  });
  it("paginates real joint groups with charge precedence, unknowns and scope-safe cursors", () => assertDayModelPagination(store, "day-model-pg"), 20_000);
  it("enforces default 200 and max 500 at real SQL grouping on PostgreSQL", () => assertDefaultDetailPage(store, "page-budget-pg"), 20_000);
  it("accepts a cursor on a distinct API process sharing the deployment signing key", async () => {
    const isolated = new URL(adminUrl!); isolated.pathname = `/${databaseName}`;
    const code = `import { MultiremiStore } from '@multiremi/store.js';
      import { PostgresSyncDatabase } from '@multiremi/store/db/postgres.js';
      const db = new PostgresSyncDatabase(process.env.USAGE_DETAIL_FIXTURE_URL);
      try {
        const page = new MultiremiStore(db).getUsageReport({workspaceId:'local',days:null,tz:'UTC',include:'day_model',detailLimit:1,
          detailCursor:process.env.USAGE_DETAIL_FIXTURE_CURSOR || undefined}).day_model;
        console.log(JSON.stringify({count:page.rows.length,cursor:page.next_cursor}));
      } finally { db.close(); }`;
    const run = async (cursor?: string) => {
      const child = Bun.spawn([process.execPath, "--eval", code], { cwd: process.cwd(), env: { ...process.env, JWT_SECRET: "isolated-pagination-signing-fixture", USAGE_DETAIL_FIXTURE_URL: isolated.toString(),
        ...(cursor ? { USAGE_DETAIL_FIXTURE_CURSOR: cursor } : {}) }, stdout: "pipe", stderr: "pipe" });
      const [stdout, _stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exit !== 0) throw new Error(`Isolated cursor process failed (${exit})`);
      return JSON.parse(stdout) as { count: number; cursor: string | null };
    };
    const first = await run();
    if (!first.cursor) throw new Error("Missing isolated first-page cursor");
    const next = await run(first.cursor);
    if (first.count !== 1 || next.count !== 1 || first.cursor === next.cursor) throw new Error("Distinct process pagination did not advance");
  }, 20_000);
});
