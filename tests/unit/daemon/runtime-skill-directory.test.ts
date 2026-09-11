import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadRuntimeLocalSkillBundle, scanRuntimeSkillDirectory } from "@multiremi/worker/local-skills.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remi-skill-directory-"));
  temporary.push(root);
  return root;
}
function skill(root: string, key: string, name = key) {
  const dir = join(root, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use for a directory import test.\n---\n# ${name}\n`);
  return dir;
}

describe("Runtime selected Skill directory", () => {
  it("keeps PNG support files importable and preserves their bytes", async () => {
    const root = fixture();
    const dir = skill(root, "with-image");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64");
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "preview.png"), png);
    const result = await scanRuntimeSkillDirectory("codex", root);
    expect(result.skills[0]?.error).toBeUndefined();
    const bundle = loadRuntimeLocalSkillBundle("codex", result.root, "with-image", true);
    const attachment = bundle.files.find(file => file.path === "references/preview.png")!;
    expect(attachment.encoding).toBe("base64");
    expect(Buffer.from(attachment.content, "base64")).toEqual(png);
    const defaultBundle = loadRuntimeLocalSkillBundle("codex", root, "with-image");
    expect(defaultBundle.files).toEqual(bundle.files);
  });

  it("preserves UTF-8 BOM and invalid UTF-8 support files without changing bytes", async () => {
    const root = fixture();
    const dir = skill(root, "byte-preservation");
    const fixtures = { "bom.txt": Buffer.from("\uFEFF你好\r\n"), "legacy.txt": Buffer.from([0xff, 0xfe, 0x41]) };
    for (const [path, bytes] of Object.entries(fixtures)) writeFileSync(join(dir, path), bytes);
    const scan = await scanRuntimeSkillDirectory("codex", root);
    expect(scan.skills[0]?.error).toBeUndefined();
    const bundle = loadRuntimeLocalSkillBundle("codex", scan.root, "byte-preservation", true);
    for (const file of bundle.files) {
      expect(Buffer.from(file.content, file.encoding ?? "utf8")).toEqual(fixtures[file.path as keyof typeof fixtures]);
    }
  });

  it("discovers hidden and deeply nested Skills with stable relative keys", async () => {
    const root = fixture();
    skill(root, ".system/helper");
    skill(root, "one/two/three/four/five/helper");
    skill(root, ".git/ignored");
    skill(root, "node_modules/ignored");
    const result = await scanRuntimeSkillDirectory("codex", root);
    expect(result.root).toBe(realpathSync(root));
    expect(result.warnings).toEqual([]);
    expect(result.skills.map((item) => item.key)).toEqual([".system/helper", "one/two/three/four/five/helper"]);
    for (const candidate of result.skills) {
      expect(candidate.error).toBeUndefined();
      const bundle = loadRuntimeLocalSkillBundle("codex", result.root, candidate.key, true);
      expect(bundle.name).toBe(candidate.name);
    }
  });

  it("imports a root Skill and preserves its full text bundle without changing the source", async () => {
    const root = fixture();
    skill(root, ".", "root-skill");
    mkdirSync(join(root, "references"));
    writeFileSync(join(root, "references", "SKILL.md"), "An example, not a separately selectable Skill.");
    writeFileSync(join(root, ".config"), "hidden support text");
    writeFileSync(join(root, "LICENSE"), "license text");
    const before = readFileSync(join(root, "SKILL.md"), "utf8");
    const result = await scanRuntimeSkillDirectory("claude", root);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({ key: ".", name: "root-skill", fileCount: 4 });
    const bundle = loadRuntimeLocalSkillBundle("claude", result.root, ".", true);
    expect(bundle.files.map((file) => file.path)).toEqual([".config", "LICENSE", "references/SKILL.md"]);
    expect(bundle.files.find((file) => file.path === ".config")?.content).toBe("hidden support text");
    expect(bundle.content).toBe(before);
    expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe(before);
  });

  it("exposes incomplete bundles as non-importable while keeping valid siblings", async () => {
    const root = fixture();
    const binary = skill(root, "binary-main");
    writeFileSync(join(binary, "SKILL.md"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const oversize = skill(root, "large");
    writeFileSync(join(oversize, "notes.md"), "x".repeat((8 << 20) + 1));
    const linked = skill(root, "linked-support");
    symlinkSync(join(binary, "SKILL.md"), join(linked, "reference.md"));
    skill(root, "valid");
    const result = await scanRuntimeSkillDirectory("codex", root);
    expect(result.skills).toHaveLength(4);
    for (const key of ["binary-main", "large", "linked-support"]) {
      expect(result.skills.find((item) => item.key === key)?.error).toBeTruthy();
      expect(() => loadRuntimeLocalSkillBundle("codex", result.root, key, true)).toThrow();
    }
    expect(result.skills.find((item) => item.key === "valid")?.error).toBeUndefined();
  });

  it("supports linked Skill directories without looping on directory aliases", async () => {
    const root = fixture();
    const shared = fixture();
    const target = skill(shared, "helper");
    symlinkSync(target, join(root, "helper"), "dir");
    symlinkSync(root, join(root, "loop"), "dir");
    const result = await scanRuntimeSkillDirectory("codex", root);
    expect(result.skills.map((item) => item.key)).toEqual(["helper"]);
    expect(loadRuntimeLocalSkillBundle("codex", result.root, "helper", true).name).toBe("helper");
  });

  it.skipIf(process.platform === "win32")("preserves a linked root with trailing whitespace without reading its sibling", async () => {
    const root = fixture();
    const selected = skill(root, "helper ", "selected");
    skill(root, "helper", "wrong-sibling");
    const link = join(root, "link");
    symlinkSync(selected, link, "dir");
    const result = await scanRuntimeSkillDirectory("codex", link);
    expect(result.root).toBe(realpathSync(selected));
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({ key: ".", name: "selected" });
    expect(loadRuntimeLocalSkillBundle("codex", result.root, ".", true).name).toBe("selected");
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO main file before reading it", () => {
    const root = fixture();
    execFileSync("mkfifo", [join(root, "SKILL.md")]);
    // A subprocess timeout makes a regression fail instead of blocking the whole test runner.
    const output = execFileSync(process.execPath, ["-e", `
      import { scanRuntimeSkillDirectory } from "./packages/server/src/worker/local-skills.ts";
      console.log(JSON.stringify(await scanRuntimeSkillDirectory("codex", ${JSON.stringify(root)})));
    `], { cwd: process.cwd(), encoding: "utf8", timeout: 2_000 });
    expect(JSON.parse(output).skills[0].error).toBe("SKILL.md must be a regular file");
  });

  it.skipIf(process.platform === "win32")("rejects file and Skill keys that path normalization would corrupt", async () => {
    const root = fixture();
    const colliding = skill(root, "colliding");
    mkdirSync(join(colliding, "a"));
    writeFileSync(join(colliding, "a", "b.txt"), "first");
    writeFileSync(join(colliding, "a\\b.txt"), "second");
    const spaced = skill(root, "spaced");
    writeFileSync(join(spaced, "trailing-space "), "keep filename");
    skill(root, " bad-key");
    skill(root, "ambiguous\\key");
    const result = await scanRuntimeSkillDirectory("codex", root);
    expect(result.skills).toHaveLength(3);
    for (const key of ["colliding", " bad-key"]) expect(result.skills.find(candidate => candidate.key === key)?.error).toContain("cannot be preserved");
    expect(result.skills.find(candidate => candidate.key === "spaced")?.error).toBeUndefined();
    expect(loadRuntimeLocalSkillBundle("codex", result.root, "spaced", true).files[0]?.path).toBe("trailing-space ");
    expect(result.warnings.join(" ")).toContain("ambiguous\\key");
    await expect(scanRuntimeSkillDirectory("codex", join(root, "ambiguous\\key"))).rejects.toThrow("cannot be preserved");
    expect(() => loadRuntimeLocalSkillBundle("codex", root, "colliding", true)).toThrow("cannot be preserved");
  });

  it("fails invalid directories and keys instead of treating them as an empty catalog", async () => {
    const root = fixture();
    await expect(scanRuntimeSkillDirectory("codex", "relative/path")).rejects.toThrow("absolute path");
    await expect(scanRuntimeSkillDirectory("codex", join(root, "missing"))).rejects.toThrow();
    writeFileSync(join(root, "file"), "not a directory");
    await expect(scanRuntimeSkillDirectory("codex", join(root, "file"))).rejects.toThrow("not a directory");
    for (const key of ["../escape", "/absolute", "C:/escape", "a/../b", "a\\..\\b"]) {
      expect(() => loadRuntimeLocalSkillBundle("codex", root, key, true)).toThrow("invalid skill key");
    }
  });

  it("reports an incomplete scan when the directory fan-out exceeds its bound", async () => {
    const root = fixture();
    for (let index = 0; index < 10_001; index++) writeFileSync(join(root, `file-${index}`), "");
    const result = await scanRuntimeSkillDirectory("codex", root);
    expect(result.warnings.join(" ")).toContain("Scan incomplete");
  });

  it("imports a large collection of subskills and still rejects file-count and byte limits", async () => {
    const root = fixture();
    const dir = skill(root, "collection");
    for (let index = 0; index < 949; index++) writeFileSync(join(dir, `reference-${index}.md`), "reference\n".repeat(1_200));
    let result = await scanRuntimeSkillDirectory("codex", root);
    expect(result.skills[0]).toMatchObject({ fileCount: 950 });
    expect(result.skills[0]?.error).toBeUndefined();
    expect(loadRuntimeLocalSkillBundle("codex", result.root, "collection", true).files).toHaveLength(949);
    for (let index = 949; index < 1_025; index++) writeFileSync(join(dir, `reference-${index}.md`), "");
    result = await scanRuntimeSkillDirectory("codex", root);
    expect(result.skills[0]?.error).toContain("1024 files");

    const bytesDir = skill(root, "byte-limit");
    for (let index = 0; index < 4; index++) writeFileSync(join(bytesDir, `${index}.bin`), Buffer.alloc(8 << 20));
    result = await scanRuntimeSkillDirectory("codex", bytesDir);
    expect(result.skills[0]?.error).toContain("33554432 bytes in total");
  });
});
