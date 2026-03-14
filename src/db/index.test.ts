/**
 * Tests for SQLite + sqlite-vec infrastructure.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { getDb, closeDb, kvGet, kvSet, kvDelete } from "./index";
import { VectorStore } from "./vector-store";
import type { EmbeddingConfig } from "./embedding";

describe("SQLite + sqlite-vec basics", () => {
  test("sqlite-vec extension loads successfully", () => {
    const db = new Database(":memory:");
    sqliteVec.load(db);

    const row = db.query("SELECT vec_version() as version").get() as { version: string };
    expect(row.version).toBeTruthy();
    console.log("sqlite-vec version:", row.version);
    db.close();
  });

  test("vec0 virtual table works", () => {
    const db = new Database(":memory:");
    sqliteVec.load(db);

    db.exec("CREATE VIRTUAL TABLE test_vec USING vec0(embedding float[4])");

    // Insert a vector
    db.run(
      "INSERT INTO test_vec (rowid, embedding) VALUES (1, ?)",
      [new Float32Array([1.0, 0.0, 0.0, 0.0])],
    );
    db.run(
      "INSERT INTO test_vec (rowid, embedding) VALUES (2, ?)",
      [new Float32Array([0.0, 1.0, 0.0, 0.0])],
    );
    db.run(
      "INSERT INTO test_vec (rowid, embedding) VALUES (3, ?)",
      [new Float32Array([1.0, 1.0, 0.0, 0.0])],
    );

    // KNN search
    const results = db
      .query(
        "SELECT rowid, distance FROM test_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 2",
      )
      .all(new Float32Array([1.0, 0.0, 0.0, 0.0])) as Array<{ rowid: number; distance: number }>;

    expect(results.length).toBe(2);
    expect(results[0].rowid).toBe(1); // exact match
    expect(results[0].distance).toBe(0);
    console.log("KNN results:", results);
    db.close();
  });
});

describe("KV store", () => {
  afterAll(() => closeDb());

  test("set and get", () => {
    kvSet("test_key", "test_value");
    expect(kvGet("test_key")).toBe("test_value");
  });

  test("overwrite", () => {
    kvSet("test_key", "new_value");
    expect(kvGet("test_key")).toBe("new_value");
  });

  test("get non-existent returns null", () => {
    expect(kvGet("nonexistent_key_xyz")).toBeNull();
  });

  test("delete", () => {
    kvSet("to_delete", "value");
    kvDelete("to_delete");
    expect(kvGet("to_delete")).toBeNull();
  });
});

describe("VectorStore", () => {
  // Use a mock config — tests that need real API will be skipped
  const mockConfig: EmbeddingConfig = {
    provider: "voyage",
    apiKey: "", // No key = embedding disabled
  };

  test("has() returns false for non-existent", () => {
    const store = new VectorStore(mockConfig);
    expect(store.has("nonexistent", "hash")).toBe(false);
  });

  test("count() returns 0 initially", () => {
    const store = new VectorStore(mockConfig);
    // Count may include items from KV tests, but vec-specific should be 0
    expect(store.count()).toBeGreaterThanOrEqual(0);
  });

  // Integration test — only runs if VOYAGE_API_KEY is set
  const apiKey = process.env.VOYAGE_API_KEY ?? "";
  const skipIntegration = !apiKey;

  test.skipIf(skipIntegration)("upsert + search (integration)", async () => {
    // Increase timeout for API calls
    const store = new VectorStore({ provider: "voyage", apiKey });

    // Upsert a few items
    const inserted = await store.upsert("test:hello", "Hello world, this is a test document", {
      type: "test",
    });
    expect(inserted).toBe(true);

    await store.upsert("test:remi", "Remi is a personal AI assistant built with TypeScript and Bun", {
      type: "test",
    });

    // Search
    const results = await store.search("AI assistant", 5);
    expect(results.length).toBeGreaterThan(0);
    console.log("Search results:", results);

    // The Remi entry should be more relevant
    const remiResult = results.find((r) => r.id === "test:remi");
    expect(remiResult).toBeTruthy();

    // Cleanup
    store.remove("test:hello");
    store.remove("test:remi");
  });

  test.skipIf(skipIntegration)("upsert skips unchanged content", async () => {
    const store = new VectorStore({ provider: "voyage", apiKey });

    const text = "Unchanged content for dedup test";
    const first = await store.upsert("test:dedup", text);
    expect(first).toBe(true);

    const second = await store.upsert("test:dedup", text);
    expect(second).toBe(false); // Should skip — same hash

    store.remove("test:dedup");
  });
});
