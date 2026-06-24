import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ClaudeAdapter } from "../../src/daemon/agent-runtime/config-hub/adapters/claude.js";
import { CodexAdapter } from "../../src/daemon/agent-runtime/config-hub/adapters/codex.js";
import { GeminiAdapter } from "../../src/daemon/agent-runtime/config-hub/adapters/gemini.js";
import { AdapterRegistry } from "../../src/daemon/agent-runtime/config-hub/adapters/base.js";
import { SqliteManifestStore } from "../../src/daemon/agent-runtime/config-hub/db/dao.js";
import { migrateConfigHub } from "../../src/daemon/agent-runtime/config-hub/db/main-tables.js";
import { openCCSwitchDb } from "../../src/daemon/agent-runtime/config-hub/db/cc-switch-db.js";
import {
  PromptsService,
  extractBlock,
  upsertBlock,
  removeBlock,
} from "../../src/daemon/agent-runtime/config-hub/prompts-service.js";

describe("prompt block helpers (pure)", () => {
  it("extractBlock finds inner content", () => {
    const t = "before\n<!-- hub:start -->\nhello\n<!-- hub:end -->\nafter";
    const e = extractBlock(t);
    expect(e.hasMarkers).toBe(true);
    expect(e.inner).toBe("hello");
  });

  it("upsertBlock appends if no marker", () => {
    const out = upsertBlock("ORIGINAL", "X");
    expect(out).toContain("<!-- hub:start -->");
    expect(out.startsWith("ORIGINAL")).toBe(true);
  });

  it("upsertBlock replaces in place if marker exists", () => {
    const t = "A\n<!-- hub:start -->\nold\n<!-- hub:end -->\nB";
    const out = upsertBlock(t, "new");
    expect(out).toContain("new");
    expect(out).not.toContain("old");
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("B")).toBe(true);
  });

  it("removeBlock deletes the block but keeps surrounding text", () => {
    const t = "user notes\n\n<!-- hub:start -->\nhub\n<!-- hub:end -->\n\ntail";
    const out = removeBlock(t);
    expect(out).not.toContain("hub:start");
    expect(out).toContain("user notes");
    expect(out).toContain("tail");
  });
});

// ── integration with files ──────────────────────────────────

let dir: string, fakeHome: string;
let ccDb: Database, mainDb: Database;
let registry: AdapterRegistry;
let svc: PromptsService;

beforeEach(() => {
  dir = join(tmpdir(), `cfghub-prompts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fakeHome = join(dir, "home");
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  mkdirSync(join(fakeHome, ".codex"), { recursive: true });
  mkdirSync(join(fakeHome, ".gemini"), { recursive: true });

  registry = new AdapterRegistry();
  registry.register(new ClaudeAdapter(fakeHome));
  registry.register(new CodexAdapter(fakeHome));
  registry.register(new GeminiAdapter(fakeHome));

  ccDb = openCCSwitchDb(join(dir, "cc-switch.db"));
  mainDb = new Database(join(dir, "main.db"));
  migrateConfigHub(mainDb);
  svc = new PromptsService(ccDb, registry, new SqliteManifestStore(mainDb));
});
afterEach(() => {
  ccDb.close();
  mainDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const claudeMd = () => join(fakeHome, ".claude", "CLAUDE.md");
const agentsMd = () => join(fakeHome, ".codex", "AGENTS.md");
const geminiMd = () => join(fakeHome, ".gemini", "GEMINI.md");

describe("PromptsService", () => {
  it("upsertCanonical fans out the block into all three files", () => {
    svc.upsertCanonical({ id: "p1", name: "P1", content: "hello world" });
    for (const f of [claudeMd(), agentsMd(), geminiMd()]) {
      const text = readFileSync(f, "utf8");
      expect(text).toContain("<!-- hub:start -->");
      expect(text).toContain("hello world");
      expect(text).toContain("<!-- hub:end -->");
    }
  });

  it("preserves user content outside the block when fanning out", () => {
    writeFileSync(claudeMd(), "USER PROSE TOP\n");
    svc.upsertCanonical({ id: "p2", name: "P2", content: "shared" });
    const text = readFileSync(claudeMd(), "utf8");
    expect(text.startsWith("USER PROSE TOP")).toBe(true);
    expect(text).toContain("shared");
  });

  it("disable removes only the block, leaves user content", () => {
    writeFileSync(claudeMd(), "USER PROSE\n");
    svc.upsertCanonical({ id: "p3", name: "P3", content: "x" });
    svc.setEnabled("p3", false);
    const text = readFileSync(claudeMd(), "utf8");
    expect(text).toContain("USER PROSE");
    expect(text).not.toContain("hub:start");
  });

  it("model edits file's block → next sync imports it back and fans out", () => {
    svc.upsertCanonical({ id: "p4", name: "P4", content: "v1" });
    // Simulate the tool/model rewriting the block content
    const orig = readFileSync(claudeMd(), "utf8");
    const edited = orig.replace("v1", "v2-MODEL");
    writeFileSync(claudeMd(), edited);

    const report = svc.syncAll();
    expect(report.byApp.claude!.action).toBe("imported");
    expect(svc.get("p4")!.content).toBe("v2-MODEL");
    // After import the other files should now also reflect v2-MODEL on next sync
    svc.syncAll();
    expect(readFileSync(agentsMd(), "utf8")).toContain("v2-MODEL");
    expect(readFileSync(geminiMd(), "utf8")).toContain("v2-MODEL");
  });

  it("both DB and file edited since last sync → conflict, file untouched", () => {
    svc.upsertCanonical({ id: "p5", name: "P5", content: "base" });
    // Edit file in place
    const orig = readFileSync(claudeMd(), "utf8");
    writeFileSync(claudeMd(), orig.replace("base", "FILE-NEW"));
    // Edit DB canonical directly (simulating user typing in hub UI)
    ccDb.run(`UPDATE prompts SET content = ? WHERE enabled = 1`, ["DB-NEW"]);

    const report = svc.syncAll();
    expect(report.byApp.claude!.action).toBe("conflict");
    expect(readFileSync(claudeMd(), "utf8")).toContain("FILE-NEW"); // untouched
    expect(report.conflicts.length).toBeGreaterThan(0);
  });

  it("missing markers → restored on next sync without losing model edits", () => {
    svc.upsertCanonical({ id: "p6", name: "P6", content: "managed" });
    // Whole-file rewrite (e.g. /init) drops our markers
    writeFileSync(claudeMd(), "MODEL REWROTE THIS WHOLESALE\n");
    const report = svc.syncAll();
    expect(["written", "marker_restored"]).toContain(report.byApp.claude!.action);
    const text = readFileSync(claudeMd(), "utf8");
    expect(text).toContain("MODEL REWROTE");
    expect(text).toContain("<!-- hub:start -->");
    expect(text).toContain("managed");
  });

  it("idempotent: second sync with no DB/file change is a no-op write", () => {
    svc.upsertCanonical({ id: "p7", name: "P7", content: "stable" });
    const before = readFileSync(claudeMd(), "utf8");
    svc.syncAll();
    const after = readFileSync(claudeMd(), "utf8");
    expect(after).toBe(before);
  });
});
