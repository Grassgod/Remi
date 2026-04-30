import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory/store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `remi-test-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("Manifest top 10", () => {
  it("shows all entities when <= 10", () => {
    for (let i = 0; i < 5; i++) {
      store.remember(`Entity${i}`, "software", `description ${i}`);
    }
    const manifest = store["_buildManifest"]();
    expect(manifest).toContain("Entity0");
    expect(manifest).toContain("Entity4");
    expect(manifest).not.toContain("+");
  });

  it("truncates to top 10 with +N more when > 10", () => {
    for (let i = 0; i < 15; i++) {
      store.remember(`Entity${i}`, "software", `description ${i}`);
    }
    const manifest = store["_buildManifest"]();
    // Should have exactly 10 entity rows + 1 "+N more" row + header rows
    const entityRows = manifest.split("\n").filter((l: string) => l.includes("| 实体 |"));
    expect(entityRows.length).toBe(11); // 10 entities + 1 "+5 more"
    expect(manifest).toContain("+5 more");
    expect(manifest).toContain(`recall("关键词") 查看`);
  });

  it("sorts by importance * recency", () => {
    // Create entities with different importance
    store.remember("LowImportance", "software", "low");
    store.remember("HighImportance", "software", "high");

    // Manually set importance via frontmatter
    const entries = [...store["_index"].entries()];
    for (const [path, meta] of entries) {
      if (meta.name === "HighImportance") {
        store["_index"].set(path, { ...meta, importance: 1.0 });
      } else if (meta.name === "LowImportance") {
        store["_index"].set(path, { ...meta, importance: 0.1 });
      }
    }

    const manifest = store["_buildManifest"]();
    const highIdx = manifest.indexOf("HighImportance");
    const lowIdx = manifest.indexOf("LowImportance");
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

describe("Manifest no extended sections", () => {
  it("does not include extended MEMORY.md sections", () => {
    store.appendMemory("\n## From 2026-03-15\n- test entry\n");
    const manifest = store["_buildManifest"]();
    // Should not have "From 2026-03-15" in manifest (removed in v3)
    expect(manifest).not.toContain("From 2026-03-15");
  });
});
