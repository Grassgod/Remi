import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, setDbPath } from "@shared/db/index.js";
import { openMultiremiDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { resolveSqlDialect } from "@multiremi/store/migrations.js";
import { deserializeSqliteDatabase, markSqliteDialect, openSqliteDatabase } from "@multiremi/store/db/sqlite.js";

const databases: Database[] = [];
const directories: string[] = [];
const previousUrl = process.env.MULTIREMI_DATABASE_URL;

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  closeDb();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (previousUrl === undefined) delete process.env.MULTIREMI_DATABASE_URL;
  else process.env.MULTIREMI_DATABASE_URL = previousUrl;
});

describe("SQLite database entry", () => {
  test("default handle retains Database queries, statements, transactions and serialization", () => {
    const db: Database = openSqliteDatabase();
    databases.push(db);
    db.exec("CREATE TABLE sample (value INTEGER)");
    db.transaction(() => db.prepare("INSERT INTO sample VALUES (?)").run(42))();
    expect(db.query<{ value: number }, []>("SELECT value FROM sample").get()).toEqual({ value: 42 });
    expect(db.serialize().byteLength).toBeGreaterThan(0);
    process.env.MULTIREMI_DATABASE_URL = "postgres://unused.invalid/example";
    expect(resolveSqlDialect(db as unknown as SqlDatabase)).toBe("sqlite");
  });

  test("forwards filenames and readonly/create options", () => {
    const directory = mkdtempSync(join(tmpdir(), "mul460-sqlite-"));
    directories.push(directory);
    const filename = join(directory, "test.sqlite");
    const writer = openSqliteDatabase(filename, { create: true });
    databases.push(writer);
    writer.exec("CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (42)");
    const reader = openSqliteDatabase(filename, { readonly: true });
    databases.push(reader);
    expect(reader.dialect).toBe("sqlite");
    expect(reader.query("SELECT value FROM sample").get()).toEqual({ value: 42 });
    expect(() => reader.run("INSERT INTO sample VALUES (43)")).toThrow();
  });

  test("marks the same existing object and forwards through a proxy", () => {
    const wrapper = { query: () => "unchanged" };
    expect(wrapper).toBe(markSqliteDialect(wrapper));
    expect(markSqliteDialect(wrapper).query()).toBe("unchanged");
    const proxy = new Proxy({ query: wrapper.query }, {});
    expect(proxy).toBe(markSqliteDialect(proxy));
    expect(markSqliteDialect(proxy).dialect).toBe("sqlite");
  });

  test("restored backups retain their data and dialect", () => {
    const original = openSqliteDatabase();
    databases.push(original);
    original.exec("CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (42)");
    const restored = deserializeSqliteDatabase(original.serialize(), { readonly: true });
    databases.push(restored);
    expect(restored.dialect).toBe("sqlite");
    expect(restored.query("SELECT value FROM sample").get()).toEqual({ value: 42 });
  });

  test("production SQLite entry marks the shared singleton without wrapping it", () => {
    delete process.env.MULTIREMI_DATABASE_URL;
    setDbPath(":memory:");
    const shared = getDb();
    const db = openMultiremiDatabase();
    expect(db).toBe(shared);
    expect(db.dialect).toBe("sqlite");
    expect(db.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
  });
});
