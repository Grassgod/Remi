import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, CONTEXT_WARN_THRESHOLD } from "../src/memory/store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `remi-test-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("EnsureInitialized", () => {
  it("creates directory structure", () => {
    expect(existsSync(join(store.root, "entities", "people"))).toBe(true);
    expect(existsSync(join(store.root, "entities", "organizations"))).toBe(true);
    expect(existsSync(join(store.root, "entities", "decisions"))).toBe(true);
    expect(existsSync(join(store.root, "daily"))).toBe(true);
    expect(existsSync(join(store.root, ".versions"))).toBe(true);
  });

  it("creates initial MEMORY.md", () => {
    const content = store.readMemory();
    expect(content).toContain("个人记忆");
    expect(content).toContain("用户偏好");
  });

  it("is idempotent", () => {
    store["_ensureInitialized"]();
    store["_ensureInitialized"]();
    expect(existsSync(join(store.root, "entities", "people"))).toBe(true);
  });
});

describe("MemoryIndex", () => {
  it("builds empty index", () => {
    expect(store["_index"].size).toBe(0);
  });

  it("builds index with entity", () => {
    store.remember("Alice", "person", "CV expert");
    expect(store["_index"].size).toBe(1);
    const values = [...store["_index"].values()];
    expect(values[0].name).toBe("Alice");
    expect(values[0].type).toBe("person");
  });

  it("invalidates index", () => {
    const result = store.remember("Bob", "person", "Backend dev");
    expect(result).toContain("已创建");
    const path = store._findEntityByName("Bob");
    expect(path).not.toBeNull();
    store._invalidateIndex(path!);
    expect(store["_index"].get(path!)!.name).toBe("Bob");
  });
});

describe("Frontmatter", () => {
  it("parses normal", () => {
    store.remember("Alice", "person", "Test observation");
    const path = store._findEntityByName("Alice")!;
    const meta = store._parseFrontmatter(path);
    expect(meta.type).toBe("person");
    expect(meta.name).toBe("Alice");
    expect(meta.source).toBe("user-explicit");
  });

  it("parses missing file", () => {
    const meta = store._parseFrontmatter(join(store.root, "nonexistent.md"));
    expect(meta).toEqual({});
  });

  it("parses malformed", () => {
    const badFile = join(store.root, "bad.md");
    writeFileSync(badFile, "no frontmatter here", "utf-8");
    const meta = store._parseFrontmatter(badFile);
    expect(typeof meta).toBe("object");
  });
});

describe("Slugify", () => {
  it("handles english", () => {
    expect(store._slugify("Alice Chen")).toBe("Alice-Chen");
  });

  it("handles chinese", () => {
    expect(store._slugify("王伟")).toBe("王伟");
  });

  it("handles special chars", () => {
    expect(store._slugify('foo<>:"/\\|?*bar')).toBe("foobar");
  });

  it("handles empty string", () => {
    expect(store._slugify("")).toBe("unnamed");
  });

  it("handles mixed", () => {
    expect(store._slugify("Hub-spoke 架构")).toBe("Hub-spoke-架构");
  });
});

describe("ResolvePath", () => {
  it("resolves new entity", () => {
    const base = join(store.root, "entities");
    const path = store._resolveEntityPath("Alice", "person", base);
    expect(path).toBe(join(base, "people", "Alice.md"));
  });

  it("resolves existing match", () => {
    store.remember("Alice", "person", "First obs");
    const base = join(store.root, "entities");
    const path = store._resolveEntityPath("Alice", "person", base);
    expect(existsSync(path)).toBe(true);
  });

  it("handles collision", () => {
    const base = join(store.root, "entities");
    const typeDir = join(base, "people");
    mkdirSync(typeDir, { recursive: true });
    writeFileSync(join(typeDir, "Alice.md"), "---\nname: Alice Other\n---\n", "utf-8");
    const path = store._resolveEntityPath("Alice", "person", base);
    expect(path.endsWith("Alice-2.md")).toBe(true);
  });
});

describe("EntityCRUD", () => {
  it("renders new entity", () => {
    const content = store["_renderNewEntity"]("Alice", "person", "CV expert");
    expect(content).toContain("type: person");
    expect(content).toContain("name: Alice");
    expect(content).toContain("source: agent-inferred");
    expect(content).toContain("## 备注");
    expect(content).toContain("CV expert");
  });

  it("appends observation", () => {
    store.remember("Alice", "person", "Initial");
    const path = store._findEntityByName("Alice")!;
    store["_appendObservation"](path, "New observation");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("New observation");
    expect(content).toContain("## 备注");
  });

  it("updates frontmatter timestamp", () => {
    store.remember("Alice", "person", "Initial");
    const path = store._findEntityByName("Alice")!;
    store["_updateFrontmatterTimestamp"](path);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("updated:");
  });
});

describe("Backup", () => {
  it("creates backup", () => {
    store.remember("Alice", "person", "Initial");
    const path = store._findEntityByName("Alice")!;
    store["_backup"](path);
    const versions = readdirSync(join(store.root, ".versions")).filter((f) =>
      f.startsWith("Alice-"),
    );
    expect(versions.length).toBeGreaterThanOrEqual(1);
  });

  it("cleans up to 10 versions", () => {
    store.remember("Alice", "person", "Initial");
    const path = store._findEntityByName("Alice")!;
    const versionsDir = join(store.root, ".versions");
    // Create 15 backups
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(versionsDir, `Alice-2026${String(i).padStart(4, "0")}T000000.md`), `v${i}`);
    }
    store["_backup"](path);
    const versions = readdirSync(versionsDir).filter((f) => f.startsWith("Alice-"));
    expect(versions.length).toBeLessThanOrEqual(10);
  });
});

describe("Recall", () => {
  it("exact name match returns full text", () => {
    store.remember("Alice Chen", "person", "CV expert at Acme");
    const result = store.recall("Alice Chen");
    expect(result).toContain("type: person");
    expect(result).toContain("Alice Chen");
  });

  it("matches aliases", () => {
    const entityDir = join(store.root, "entities", "people");
    mkdirSync(entityDir, { recursive: true });
    const content =
      "---\n" +
      "type: person\n" +
      "name: Alice Chen\n" +
      "created: 2026-01-01T00:00:00\n" +
      "updated: 2026-01-01T00:00:00\n" +
      "tags: []\n" +
      "source: user-explicit\n" +
      'summary: "CV expert"\n' +
      "aliases: [Alice, AC]\n" +
      "related: []\n" +
      "---\n\n# Alice Chen\n";
    writeFileSync(join(entityDir, "Alice-Chen.md"), content, "utf-8");
    store._buildIndex();

    const result = store.recall("Alice");
    expect(result).toBeTruthy();
  });

  it("matches body substring", () => {
    store.remember("Bob", "person", "works on PaddleOCR pipeline");
    const result = store.recall("PaddleOCR");
    expect(result).toContain("Bob");
  });

  it("filters by type", () => {
    store.remember("Alice", "person", "engineer");
    store.remember("Acme", "organization", "tech company");
    const result = store.recall("engineer", { type: "person" });
    expect(result).toContain("Alice");
  });

  it("filters by tags", () => {
    const entityDir = join(store.root, "entities", "people");
    const content =
      "---\n" +
      "type: person\n" +
      "name: Tagged Person\n" +
      "created: 2026-01-01T00:00:00\n" +
      "updated: 2026-01-01T00:00:00\n" +
      "tags: [colleague, cv-expert]\n" +
      "source: user-explicit\n" +
      'summary: ""\n' +
      "aliases: []\n" +
      "related: []\n" +
      "---\n\n# Tagged Person\n";
    writeFileSync(join(entityDir, "Tagged-Person.md"), content, "utf-8");
    store._buildIndex();

    const result = store.recall("Tagged Person", { tags: ["colleague"] });
    expect(result).toContain("Tagged Person");
  });

  it("searches daily logs", () => {
    store.appendDaily("discussed PaddleOCR optimization", "2026-02-17");
    const result = store.recall("PaddleOCR");
    expect(result).toContain("2026-02-17");
  });

  it("searches project memory", () => {
    const project = join(tmpDir, "myproject");
    mkdirSync(join(project, ".remi"), { recursive: true });
    writeFileSync(
      join(project, ".remi", "memory.md"),
      "# MyProject — Hub-spoke architecture\n",
      "utf-8",
    );
    const result = store.recall("Hub-spoke", { cwd: project });
    expect(result).toBeTruthy();
  });

  it("returns empty for no match", () => {
    const result = store.recall("nonexistent-query-12345");
    expect(result).toBe("");
  });
});

describe("Remember", () => {
  it("creates new entity", () => {
    const result = store.remember("Alice", "person", "CV expert");
    expect(result).toContain("已创建");
    const path = store._findEntityByName("Alice");
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
  });

  it("appends observation", () => {
    store.remember("Alice", "person", "CV expert");
    const result = store.remember("Alice", "person", "prefers Slack");
    expect(result).toContain("已更新");
    const path = store._findEntityByName("Alice")!;
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("CV expert");
    expect(content).toContain("prefers Slack");
  });

  it("handles scope project", () => {
    const project = join(tmpDir, "myproject");
    mkdirSync(join(project, ".remi"), { recursive: true });
    writeFileSync(join(project, ".remi", "memory.md"), "# Project\n", "utf-8");
    const result = store.remember("Decision X", "decision", "chose option A", "project", project);
    expect(result).toContain("已创建");
    // Entity should be in project entities dir
    const entityFiles = readdirSync(join(project, ".remi", "entities", "decisions"));
    expect(entityFiles.length).toBe(1);
  });

  it("errors on scope project without cwd", () => {
    const result = store.remember("Test", "person", "obs", "project");
    expect(result).toContain("错误");
  });
});

describe("GatherContext", () => {
  it("default two layers", () => {
    const project = join(tmpDir, "myproject");
    mkdirSync(join(project, ".remi"), { recursive: true });
    writeFileSync(
      join(project, ".remi", "memory.md"),
      "# MyProject — test project\n",
      "utf-8",
    );
    store.writeMemory("# 个人记忆\n\nUser preference: dark mode");
    const ctx = store.gatherContext(project);
    expect(ctx).toContain("个人记忆");
    expect(ctx).toContain("MyProject");
  });

  it("module layer", () => {
    const project = join(tmpDir, "myproject");
    const mod = join(project, "src", "module");
    mkdirSync(join(project, ".remi"), { recursive: true });
    writeFileSync(join(project, ".remi", "memory.md"), "# Root project\n", "utf-8");
    mkdirSync(join(mod, ".remi"), { recursive: true });
    writeFileSync(join(mod, ".remi", "memory.md"), "# Module memory\n", "utf-8");
    const ctx = store.gatherContext(mod);
    expect(ctx).toContain("当前模块记忆");
    expect(ctx).toContain("Module memory");
  });

  it("warns on threshold", () => {
    store.writeMemory("x".repeat(CONTEXT_WARN_THRESHOLD + 100));
    const ctx = store.gatherContext();
    expect(ctx).toContain("⚠️");
  });

  it("returns content for empty context", () => {
    const freshStore = new MemoryStore(join(tmpDir, "fresh_memory"));
    const ctx = freshStore.gatherContext();
    expect(ctx).toContain("个人记忆");
  });
});

describe("ProjectRoot", () => {
  it("finds highest layer", () => {
    const root = join(tmpDir, "project");
    const child = join(root, "src", "module");
    mkdirSync(join(root, ".remi"), { recursive: true });
    mkdirSync(join(child, ".remi"), { recursive: true });
    const result = store._projectRoot(child);
    expect(result).toBe(root);
  });

  it("returns null when no .remi found", () => {
    const result = store._projectRoot(join(tmpDir, "no_project"));
    expect(result).toBeNull();
  });
});

describe("BuildManifest", () => {
  it("includes entity summary", () => {
    store.remember("Alice", "person", "CV expert");
    const manifest = store._buildManifest();
    expect(manifest).toContain("Alice");
    expect(manifest).toContain("实体");
  });

  it("includes daily entry", () => {
    store.appendDaily("test log entry", "2026-02-18");
    const manifest = store._buildManifest();
    expect(manifest).toContain("日志");
    expect(manifest).toContain("daily/");
  });

  it("includes project memory summary", () => {
    const project = join(tmpDir, "proj");
    const mod = join(project, "src", "mod");
    mkdirSync(join(project, ".remi"), { recursive: true });
    writeFileSync(join(project, ".remi", "memory.md"), "# Project root\n", "utf-8");
    mkdirSync(join(mod, ".remi"), { recursive: true });
    writeFileSync(join(mod, ".remi", "memory.md"), "# Module mem\n", "utf-8");

    const manifest = store._buildManifest(mod);
    expect(manifest).toContain("项目记忆");
  });
});

describe("MaintenanceMethods", () => {
  it("creates entity", () => {
    store.createEntity("TestEntity", "decision", "chose option A");
    const path = store._findEntityByName("TestEntity");
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
  });

  it("updates entity", () => {
    store.createEntity("TestEntity", "decision", "initial");
    store.updateEntity(
      "TestEntity",
      "---\ntype: decision\nname: TestEntity\nupdated: now\n---\n\n# Updated\n",
    );
    const path = store._findEntityByName("TestEntity")!;
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("Updated");
  });

  it("patches project memory overwrite", () => {
    const project = join(tmpDir, "proj");
    mkdirSync(join(project, ".remi"), { recursive: true });
    writeFileSync(
      join(project, ".remi", "memory.md"),
      "# Project\n\n## Architecture\nOld content\n\n## Procedures\nOld procs\n",
      "utf-8",
    );
    store.patchProjectMemory(project, "Procedures", "New procs", "overwrite");
    const content = readFileSync(join(project, ".remi", "memory.md"), "utf-8");
    expect(content).toContain("New procs");
    expect(content).not.toContain("Old procs");
  });

  it("patches project memory append", () => {
    const project = join(tmpDir, "proj");
    mkdirSync(join(project, ".remi"), { recursive: true });
    writeFileSync(
      join(project, ".remi", "memory.md"),
      "# Project\n\n## Architecture\nExisting arch\n",
      "utf-8",
    );
    store.patchProjectMemory(project, "Architecture", "New entry", "append");
    const content = readFileSync(join(project, ".remi", "memory.md"), "utf-8");
    expect(content).toContain("Existing arch");
    expect(content).toContain("New entry");
  });

  it("deletes entity", () => {
    store.createEntity("ToDelete", "person", "temporary");
    const path = store._findEntityByName("ToDelete")!;
    expect(existsSync(path)).toBe(true);
    store.deleteEntity("ToDelete");
    expect(existsSync(path)).toBe(false);
    expect(store._findEntityByName("ToDelete")).toBeNull();
  });
});

describe("V1Compat", () => {
  it("reads memory", () => {
    const content = store.readMemory();
    expect(content).toContain("个人记忆");
  });

  it("writes memory", () => {
    store.writeMemory("# Custom Memory\n\nCustom content");
    expect(store.readMemory()).toContain("Custom content");
  });

  it("appends memory", () => {
    store.appendMemory("- New fact");
    const content = store.readMemory();
    expect(content).toContain("New fact");
  });

  it("reads empty daily", () => {
    expect(store.readDaily("2099-01-01")).toBe("");
  });

  it("appends daily", () => {
    store.appendDaily("Test entry", "2026-02-18");
    const content = store.readDaily("2026-02-18");
    expect(content).toContain("Test entry");
  });

  it("cleans up old versions", () => {
    const versionsDir = join(store.root, ".versions");
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(versionsDir, `test_${i}.md`), `v${i}`);
    }
    const removed = store.cleanupOldVersions(3);
    expect(removed).toBe(7);
    const remaining = readdirSync(versionsDir).filter((f) => f.endsWith(".md"));
    expect(remaining.length).toBe(3);
  });
});
