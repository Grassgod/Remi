import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNED_DIRECTORY_QUARANTINE,
  ownedDirectoryRemovalSupport,
  recoverOwnedDirectoryQuarantineSync,
  removeOwnedDirectorySync,
} from "@daemon/agent-runtime/workspace/safe-remove.js";

describe("descriptor-safe owned directory removal", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reports descriptor-safe cleanup support to runtime health", () => {
    const support = ownedDirectoryRemovalSupport();
    if (process.platform === "linux") {
      expect(support).toEqual({ capability: "available", supported: true, error: null });
    } else {
      expect(support.capability).toBe("blocked");
      expect(support.supported).toBe(false);
      expect(support.error).toContain(process.platform);
    }
  });

  it("quarantines and removes only the selected owned directory", () => {
    const root = tempRoot(roots);
    const target = join(root, ".task-runtime", "task-1");
    const sibling = join(root, ".task-runtime", "task-2");
    mkdirSync(target, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(target, "result.jsonl"), "{}\n", { mode: 0o400 });
    writeFileSync(join(sibling, "keep.txt"), "keep\n");

    expect(removeOwnedDirectorySync(root, target)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(sibling, "keep.txt"), "utf8")).toBe("keep\n");
    expect(readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toEqual([]);
  });

  it("refuses a symlinked parent without touching the outside directory", () => {
    const root = tempRoot(roots);
    const outside = tempRoot(roots);
    const victim = join(outside, "task-1");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep.txt"), "keep\n");
    symlinkSync(outside, join(root, ".task-runtime"), "dir");

    expect(() => removeOwnedDirectorySync(root, join(root, ".task-runtime", "task-1")))
      .toThrow("must be a real directory");
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("treats a missing owned parent as already removed", () => {
    const root = tempRoot(roots);
    expect(removeOwnedDirectorySync(root, join(root, ".task-runtime", "task-1"))).toBe(false);
    expect(existsSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toBe(false);
  });

  it("retains the quarantined generation when the root fence is lost", () => {
    const root = tempRoot(roots);
    const target = join(root, "MUL-1");
    mkdirSync(target);
    writeFileSync(join(target, "session.jsonl"), "durable\n");
    let fences = 0;

    expect(() => removeOwnedDirectorySync(root, target, {
      assertRootOwner: () => {
        fences++;
        if (fences === 3) throw new Error("workspace ownership lost");
      },
    })).toThrow("workspace ownership lost");

    expect(existsSync(target)).toBe(false);
    const quarantined = readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(root, OWNED_DIRECTORY_QUARANTINE, quarantined[0]!, "session.jsonl"), "utf8"))
      .toBe("durable\n");

    expect(recoverOwnedDirectoryQuarantineSync(root)).toBe(1);
    expect(readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toEqual([]);
  });
});

function tempRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "multiremi-safe-remove-"));
  roots.push(root);
  return root;
}
