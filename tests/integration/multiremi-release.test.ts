import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMultiremiArchive,
  MULTIREMI_ARCHIVE_ENTRIES,
  MULTIREMI_RELEASE_TARGETS,
  multiremiArchiveName,
  multiremiAssetVersion,
  normalizeMultiremiTagVersion,
} from "../../scripts/build-multiremi.js";

describe("Multiremi release artifacts", () => {
  test("uses the multiremi artifact names for every supported platform", () => {
    expect(MULTIREMI_RELEASE_TARGETS.map((target) => `${target.os}-${target.arch}`)).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
    ]);
    expect(normalizeMultiremiTagVersion("0.2.0-test")).toBe("v0.2.0-test");
    expect(multiremiAssetVersion("v0.2.0-test")).toBe("0.2.0-test");
    expect(multiremiArchiveName("v0.2.0-test", { os: "linux", arch: "x64" })).toBe(
      "multiremi-0.2.0-test-linux-x64.tar.gz",
    );
  });

  test("archives the multiremi CLI and bundled Claude ACP wrapper", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-release-"));
    try {
      const targetDir = join(root, "linux-x64");
      mkdirSync(targetDir, { recursive: true });
      for (const entry of MULTIREMI_ARCHIVE_ENTRIES) {
        const path = join(targetDir, entry);
        writeFileSync(path, `#!/bin/sh\necho ${entry}\n`);
        chmodSync(path, 0o755);
      }

      const archive = join(root, "multiremi-0.2.0-test-linux-x64.tar.gz");
      createMultiremiArchive(targetDir, archive, "pipe");

      const contents = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
        .trim()
        .split("\n");
      expect(contents).toEqual([...MULTIREMI_ARCHIVE_ENTRIES]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
