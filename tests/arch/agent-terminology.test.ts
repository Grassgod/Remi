import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// A workspace Agent has one name: 智能体 in Chinese UI copy, Agent in docs,
// skills and code. The retired alias read as a separate (cloud-hosted) concept.
// Spelled with escapes so this file does not match itself.
const RETIRED_ALIAS = "\u4e91\u53cb";

const root = join(import.meta.dir, "../..");

describe("agent terminology", () => {
  test("tracked text files do not use the retired Agent alias", () => {
    const result = spawnSync("git", ["grep", "-n", "-I", "-F", RETIRED_ALIAS], { cwd: root, encoding: "utf8" });
    // git grep exits 1 when nothing matches; anything above that is a real error.
    expect(result.status === 0 || result.status === 1).toBe(true);
    expect(result.stdout.split("\n").filter(Boolean).map(line => line.split(":").slice(0, 2).join(":"))).toEqual([]);
  });
});
