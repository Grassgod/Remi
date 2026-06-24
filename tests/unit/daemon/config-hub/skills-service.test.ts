import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, lstatSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ClaudeAdapter } from "../../../../src/daemon/agent-runtime/config-hub/adapters/claude.js";
import { CodexAdapter } from "../../../../src/daemon/agent-runtime/config-hub/adapters/codex.js";
import { GeminiAdapter } from "../../../../src/daemon/agent-runtime/config-hub/adapters/gemini.js";
import { AdapterRegistry } from "../../../../src/daemon/agent-runtime/config-hub/adapters/base.js";
import { SkillsDao } from "../../../../src/daemon/agent-runtime/config-hub/db/dao.js";
import { SkillsService } from "../../../../src/daemon/agent-runtime/skills/persistent.js";
import { openConfigHubDb } from "../../../../src/daemon/agent-runtime/config-hub/db/config-hub-db.js";

let dir: string;
let fakeHome: string;
let ssotRoot: string;
let registry: AdapterRegistry;
let ccDb: Database;
let svc: SkillsService;

function makeFakeSkillSource(name: string, files: Record<string, string>): string {
  const src = join(dir, "src", name);
  mkdirSync(src, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(src, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return src;
}

beforeEach(() => {
  dir = join(tmpdir(), `cfghub-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fakeHome = join(dir, "home");
  ssotRoot = join(fakeHome, ".remi", "skills");
  mkdirSync(fakeHome, { recursive: true });
  // Mark all three tools "present" so the service writes to their dirs.
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  mkdirSync(join(fakeHome, ".codex"), { recursive: true });
  mkdirSync(join(fakeHome, ".gemini"), { recursive: true });

  registry = new AdapterRegistry();
  registry.register(new ClaudeAdapter(fakeHome));
  registry.register(new CodexAdapter(fakeHome));
  registry.register(new GeminiAdapter(fakeHome));

  ccDb = openConfigHubDb(join(dir, "config-hub.db"));
  svc = new SkillsService(new SkillsDao(ccDb), registry, ssotRoot);
});
afterEach(() => {
  ccDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SkillsService", () => {
  it("installFromDir copies to SSOT, records DB row with content_hash", () => {
    const src = makeFakeSkillSource("my-skill", { "SKILL.md": "# hi", "files/a.txt": "x" });
    const row = svc.installFromDir({ sourceDir: src });
    expect(row.id).toBe("my-skill");
    expect(row.directory).toBe("my-skill");
    expect(row.contentHash).toBeTruthy();
    expect(existsSync(join(ssotRoot, "my-skill", "SKILL.md"))).toBe(true);
  });

  it("enable for claude creates a symlink to SSOT", () => {
    const src = makeFakeSkillSource("s1", { "SKILL.md": "x" });
    svc.installFromDir({ sourceDir: src });
    svc.setEnabled("s1", "claude", true);
    const target = join(fakeHome, ".claude", "skills", "s1");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it("disable removes the link but leaves SSOT intact", () => {
    const src = makeFakeSkillSource("s2", { "SKILL.md": "x" });
    svc.installFromDir({ sourceDir: src });
    svc.setEnabled("s2", "claude", true);
    svc.setEnabled("s2", "claude", false);
    expect(existsSync(join(fakeHome, ".claude", "skills", "s2"))).toBe(false);
    expect(existsSync(join(ssotRoot, "s2", "SKILL.md"))).toBe(true);
  });

  it("uninstall removes all symlinks AND SSOT AND DB row", () => {
    const src = makeFakeSkillSource("s3", { "SKILL.md": "x" });
    svc.installFromDir({ sourceDir: src });
    svc.setEnabled("s3", "claude", true);
    svc.setEnabled("s3", "codex", true);
    svc.uninstall("s3");
    expect(existsSync(join(fakeHome, ".claude", "skills", "s3"))).toBe(false);
    expect(existsSync(join(fakeHome, ".codex", "skills", "s3"))).toBe(false);
    expect(existsSync(join(ssotRoot, "s3"))).toBe(false);
    expect(svc.list().length).toBe(0);
  });

  it("refuses to overwrite a real foreign directory at the target", () => {
    const src = makeFakeSkillSource("clash", { "SKILL.md": "x" });
    svc.installFromDir({ sourceDir: src });
    // Pre-create a real dir at the target (e.g. user's existing skill)
    const target = join(fakeHome, ".claude", "skills", "clash");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "USER_DATA.md"), "do not touch");
    const report = svc.setEnabled("clash", "claude", true);
    // Service catches the error and reports it; the real dir is preserved.
    expect(report.byApp.claude!.errors[0]).toContain("refusing");
    expect(readFileSync(join(target, "USER_DATA.md"), "utf8")).toBe("do not touch");
  });

  it("applyAll is idempotent — running twice produces same on-disk state", () => {
    const src = makeFakeSkillSource("idemp", { "SKILL.md": "x" });
    svc.installFromDir({ sourceDir: src });
    svc.setEnabled("idemp", "claude", true);
    const before = readdirSync(join(fakeHome, ".claude", "skills")).sort();
    svc.applyAll();
    const after = readdirSync(join(fakeHome, ".claude", "skills")).sort();
    expect(after).toEqual(before);
  });

  it("skips tools whose home is missing", () => {
    rmSync(join(fakeHome, ".codex"), { recursive: true, force: true });
    const src = makeFakeSkillSource("only-claude", { "SKILL.md": "x" });
    svc.installFromDir({ sourceDir: src });
    svc.setEnabled("only-claude", "codex", true);
    expect(existsSync(join(fakeHome, ".codex", "skills", "only-claude"))).toBe(false);
  });
});
