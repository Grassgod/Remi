import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const workerUrl = new URL("../../../packages/server/src/store/db/pg-worker.ts", import.meta.url);
const errorReply = 'JSON.stringify({ error: String(err?.message ?? err), source: queryCompleted ? "reply" : "query" })';

describe("MUL-427: oversized worker errors fail closed", () => {
  for (const malformed of ["missing", "non-string"] as const) {
    it.skipIf(!pgAdminUrl)(`Postgres: ${malformed} source becomes unknown and rejects COMMIT through the real shared buffer`, async () => {
      const name = `mul427_unknown_${process.pid}_${Math.floor(Math.random() * 1e8)}`;
      const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
      await admin.unsafe(`CREATE DATABASE ${name}`);
      const url = new URL(pgAdminUrl!);
      url.pathname = `/${name}`;
      const dir = mkdtempSync(join(tmpdir(), "mul427-worker-source-"));
      let db: PostgresSyncDatabase | null = null;
      try {
        const source = readFileSync(workerUrl, "utf8");
        expect(source.split(errorReply)).toHaveLength(2);
        // Only corrupt the error envelope after real SQL has failed. respond(),
        // its truncation, Atomics and the main-thread bridge remain production code.
        const envelope = `{ error: String(err?.message ?? err)${malformed === "non-string" ? ", source: 17" : ""} }`;
        const injected = source.replace(errorReply,
          `JSON.stringify(query?.includes("MUL427_MALFORMED_SOURCE") ? ${envelope} : { error: String(err?.message ?? err), source: queryCompleted ? "reply" : "query" })`);
        const path = join(dir, "pg-worker.ts");
        writeFileSync(path, injected);
        db = new PostgresSyncDatabase(url.toString(), 2048);
        const bridge = (db as unknown as { bridge: {
          worker: Worker; ctl: Int32Array; buf: Uint8Array; request: (message: { init: string }) => unknown;
        } }).bridge;
        bridge.worker.terminate();
        bridge.worker = new Worker(pathToFileURL(path).href);
        bridge.request({ init: url.toString() });
        db.exec("CREATE TABLE unknown_source_case (n INTEGER PRIMARY KEY)");
        const observed: { message: string | null; depth: number | null; reply: { source?: unknown; error?: string } } = {
          message: null, depth: null, reply: {},
        };
        const database = db;
        expect(() => database.transaction(() => {
          database.run("INSERT INTO unknown_source_case (n) VALUES (1)");
          try {
            database.run("DO $$ BEGIN RAISE EXCEPTION '%', repeat('x', 4000); END $$ /* MUL427_MALFORMED_SOURCE */");
          } catch (error) {
            observed.message = (error as Error).message;
            observed.depth = (database as unknown as { failedAtDepth: number | null }).failedAtDepth;
            const bytes = Atomics.load(bridge.ctl, 1);
            expect(bytes).toBeLessThanOrEqual(2048);
            expect(Atomics.load(bridge.ctl, 0)).toBe(2);
            observed.reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bridge.buf.slice(0, bytes)));
          }
        })()).toThrow("unrecovered statement failure at depth 1");
        expect(observed.message).toContain("postgres: " + "x".repeat(128));
        expect(observed.reply.source).toBe("unknown");
        expect(observed.reply.error).toMatch(/truncated, \d+ bytes/);
        expect(observed.depth).toBe(1);
        expect(database.inTransaction).toBe(false);
        expect(database.query("SELECT n FROM unknown_source_case").all()).toEqual([]);
      } finally {
        db?.close();
        rmSync(dir, { recursive: true, force: true });
        await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
        await admin.end();
      }
    }, 30_000);
  }
});
