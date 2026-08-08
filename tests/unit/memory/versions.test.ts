import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backupFile, MEMORY_VERSION_RETENTION } from "@memory/store/versions.js";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `remi-test-versions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function versions(): string[] {
  return readdirSync(join(root, ".versions")).sort();
}

describe("backupFile", () => {
  it("is a no-op when the source file does not exist", () => {
    backupFile(root, join(root, "missing.md"));
    expect(existsSync(join(root, ".versions"))).toBe(false);
  });

  it("names a .md backup <stem>-<ts>.md (the shape MemoryStore always produced)", () => {
    const file = join(root, "Alice.md");
    writeFileSync(file, "hello");
    backupFile(root, file);
    const [name] = versions();
    expect(name).toMatch(/^Alice-\d{8}T\d{6}\.md$/);
  });

  it("keeps the real extension instead of forcing .md", () => {
    const file = join(root, ".mcp.json");
    writeFileSync(file, "{}");
    backupFile(root, file);
    const [name] = versions();
    expect(name).toMatch(/^\.mcp-\d{8}T\d{6}\.json$/);
  });

  it("copies the file contents byte for byte", () => {
    const file = join(root, "note.md");
    writeFileSync(file, "线上告警 — 中文与 emoji 🚀");
    backupFile(root, file);
    const [name] = versions();
    expect(readFileSync(join(root, ".versions", name), "utf-8")).toBe("线上告警 — 中文与 emoji 🚀");
  });

  it("prunes to the newest `keep` backups for that stem", () => {
    const file = join(root, "Alice.md");
    writeFileSync(file, "current");
    mkdirSync(join(root, ".versions"), { recursive: true });
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(root, ".versions", `Alice-2026${String(i).padStart(4, "0")}T000000.md`), `v${i}`);
    }
    backupFile(root, file, { keep: MEMORY_VERSION_RETENTION });
    expect(versions().length).toBe(10);
  });

  it("prunes per stem and extension, so unrelated backups survive", () => {
    const file = join(root, "Alice.md");
    writeFileSync(file, "current");
    mkdirSync(join(root, ".versions"), { recursive: true });
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(root, ".versions", `Alice-2026${String(i).padStart(4, "0")}T000000.md`), `v${i}`);
    }
    writeFileSync(join(root, ".versions", "Alice-20260101T000000.json"), "{}");
    writeFileSync(join(root, ".versions", "Bob-20260101T000000.md"), "bob");
    backupFile(root, file, { keep: MEMORY_VERSION_RETENTION });
    const names = versions();
    expect(names.filter((f) => f.endsWith(".md") && f.startsWith("Alice-")).length).toBe(10);
    expect(names).toContain("Alice-20260101T000000.json");
    expect(names).toContain("Bob-20260101T000000.md");
  });

  it("keeps every backup when `keep` is omitted, the way RemiData always did", () => {
    // RemiData backs up many distinct files that share one stem (every skill's
    // SKILL.md). Pruning is by stem, so capping here would delete a *different*
    // skill's backups.
    const file = join(root, "SKILL.md");
    writeFileSync(file, "current");
    mkdirSync(join(root, ".versions"), { recursive: true });
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(root, ".versions", `SKILL-2026${String(i).padStart(4, "0")}T000000.md`), `other skill ${i}`);
    }
    backupFile(root, file);
    expect(versions().length).toBe(13);
  });
});
