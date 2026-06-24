import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateCcSwitchToRemi } from "../../../../src/daemon/agent-runtime/config-hub/migration.js";

let home: string;

const oldDb = (h: string) => join(h, ".cc-switch", "cc-switch.db");
const newDb = (h: string) => join(h, ".remi", "config-hub.db");
const oldSkills = (h: string) => join(h, ".cc-switch", "skills");
const newSkills = (h: string) => join(h, ".remi", "skills");

beforeEach(() => {
  home = join(tmpdir(), `ccmig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedOldDb(content = "OLD_DB"): void {
  mkdirSync(join(home, ".cc-switch"), { recursive: true });
  writeFileSync(oldDb(home), content);
}

function seedOldSkills(): void {
  mkdirSync(join(oldSkills(home), "demo"), { recursive: true });
  writeFileSync(join(oldSkills(home), "demo", "SKILL.md"), "# demo");
}

describe("migrateCcSwitchToRemi", () => {
  it("copies the DB when old exists and new is absent", () => {
    seedOldDb("PAYLOAD");
    migrateCcSwitchToRemi(home);
    expect(existsSync(newDb(home))).toBe(true);
    expect(readFileSync(newDb(home), "utf8")).toBe("PAYLOAD");
  });

  it("copies the skills tree when old exists and new is absent", () => {
    seedOldSkills();
    migrateCcSwitchToRemi(home);
    expect(existsSync(join(newSkills(home), "demo", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(newSkills(home), "demo", "SKILL.md"), "utf8")).toBe("# demo");
  });

  it("does NOT overwrite an existing new DB", () => {
    seedOldDb("OLD");
    mkdirSync(join(home, ".remi"), { recursive: true });
    writeFileSync(newDb(home), "NEW");
    migrateCcSwitchToRemi(home);
    expect(readFileSync(newDb(home), "utf8")).toBe("NEW");
  });

  it("does NOT overwrite an existing new skills dir", () => {
    seedOldSkills();
    mkdirSync(newSkills(home), { recursive: true });
    writeFileSync(join(newSkills(home), "marker.txt"), "KEEP");
    migrateCcSwitchToRemi(home);
    // existing new dir is preserved untouched; old "demo" is not copied in
    expect(readFileSync(join(newSkills(home), "marker.txt"), "utf8")).toBe("KEEP");
    expect(existsSync(join(newSkills(home), "demo"))).toBe(false);
  });

  it("never deletes the old paths", () => {
    seedOldDb("OLD");
    seedOldSkills();
    migrateCcSwitchToRemi(home);
    expect(existsSync(oldDb(home))).toBe(true);
    expect(existsSync(join(oldSkills(home), "demo", "SKILL.md"))).toBe(true);
  });

  it("is idempotent (second run is a no-op)", () => {
    seedOldDb("PAYLOAD");
    seedOldSkills();
    migrateCcSwitchToRemi(home);
    // mutate the new DB to prove the second run does not re-copy over it
    writeFileSync(newDb(home), "MODIFIED");
    migrateCcSwitchToRemi(home);
    expect(readFileSync(newDb(home), "utf8")).toBe("MODIFIED");
    expect(existsSync(join(newSkills(home), "demo", "SKILL.md"))).toBe(true);
  });

  it("is a no-op when nothing to migrate", () => {
    migrateCcSwitchToRemi(home);
    expect(existsSync(newDb(home))).toBe(false);
    expect(existsSync(newSkills(home))).toBe(false);
  });
});
