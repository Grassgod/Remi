import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory/store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `remi-test-recall-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let tmpDir: string;
let store: MemoryStore;

beforeEach(() => {
  tmpDir = makeTmpDir();
  store = new MemoryStore(join(tmpDir, "memory"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("recall L1 (exact match)", () => {
  it("returns full text on exact name match", async () => {
    store.remember("TestEntity", "software", "这是一个测试实体");
    const result = await store.recall("TestEntity");
    expect(result).toContain("TestEntity");
    expect(result).toContain("测试实体");
  });

  it("returns empty string when nothing matches", async () => {
    const result = await store.recall("完全不存在的东西");
    expect(result).toBe("");
  });

  it("substring match returns results", async () => {
    store.remember("Remi", "project", "飞书→Claude Code 中间件");
    const result = await store.recall("Claude Code");
    expect(result).toContain("Remi");
  });
});

describe("recall is async", () => {
  it("returns a Promise", () => {
    const result = store.recall("test");
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("remember with new frontmatter fields", () => {
  it("creates entity with importance/last_accessed/access_count", () => {
    store.remember("NewEntity", "software", "test observation");

    const entities = [...store["_index"].entries()];
    const entry = entities.find(([, meta]) => meta.name === "NewEntity");
    expect(entry).toBeTruthy();

    const [path, meta] = entry!;
    expect(meta.importance).toBe(0.5);
    expect(meta.accessCount).toBe(0);
    expect(meta.lastAccessed).toBeTruthy();

    // Check frontmatter in file
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("importance: 0.5");
    expect(content).toContain("access_count: 0");
    expect(content).toContain("last_accessed:");
  });
});

describe("_updateAccessStats", () => {
  it("updates last_accessed and access_count", () => {
    store.remember("AccessTest", "software", "test");

    const entries = [...store["_index"].entries()];
    const [path] = entries.find(([, meta]) => meta.name === "AccessTest")!;

    store["_updateAccessStats"](path);

    const meta = store["_index"].get(path)!;
    expect(meta.accessCount).toBe(1);
    const la = String(meta.lastAccessed);
    expect(la).toInclude(new Date().toISOString().slice(0, 10));
  });
});

describe("reindex", () => {
  it("returns 0 when no vector store", async () => {
    store.remember("TestEntity", "software", "test");
    const count = await store.reindex();
    expect(count).toBe(0);
  });
});
