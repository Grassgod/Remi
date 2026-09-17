import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertMultiremiBinaryVersion,
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
      "remi-0.2.0-test-linux-x64.tar.gz",
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

  test("rejects a compiled CLI that reports the wrong release version", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-version-"));
    try {
      const bin = join(root, "remi");
      writeFileSync(bin, "#!/bin/sh\necho 0.2.0\n");
      chmodSync(bin, 0o755);

      expect(() => assertMultiremiBinaryVersion(bin, "v0.2.26")).toThrow(
        "compiled remi version mismatch: expected 0.2.26, got 0.2.0",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([0, 1])("installer preflights the downloaded runtime before replacement (exit %s)", (prepareExit) => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-installer-"));
    try {
      const release = join(root, "release");
      const bin = join(root, "bin");
      const mocks = join(root, "mocks");
      for (const directory of [release, bin, mocks]) mkdirSync(directory);
      const oldBinary = "#!/bin/sh\necho old-remi\n";
      writeFileSync(join(bin, "remi"), oldBinary);
      const newBinary = `#!/bin/sh\n[ "$1 $2" = "runtime prepare" ] || exit 91\n[ "$(cat "$MULTIREMI_BIN_DIR/remi")" = "$(cat "$FIXTURE_OLD_BINARY")" ] || exit 92\nprintf prepared > "$FIXTURE_EVENTS"\nexit ${prepareExit}\n`;
      writeFileSync(join(root, "old-remi"), oldBinary);
      writeFileSync(join(release, "remi"), newBinary);
      writeFileSync(join(release, "remi-claude-agent-acp"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(release, "runtime-bundle.json"), '{"schema":1}\n');
      const archive = join(root, "release.tar.gz");
      createMultiremiArchive(release, archive, "pipe");
      writeFileSync(join(mocks, "curl"), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "-o" ]; then cp "$FIXTURE_ARCHIVE" "$2"; exit 0; fi\n shift\ndone\nexit 93\n');
      chmodSync(join(mocks, "curl"), 0o755);
      const result = spawnSync("bash", [resolve(import.meta.dir, "../../scripts/install-remi.sh")], {
        encoding: "utf8", timeout: 15_000,
        env: { ...process.env, PATH: `${mocks}:${process.env.PATH}`, MULTIREMI_VERSION: "0.0.0-test", MULTIREMI_BIN_DIR: bin,
          FIXTURE_ARCHIVE: archive, FIXTURE_EVENTS: join(root, "events"), FIXTURE_OLD_BINARY: join(root, "old-remi") },
      });
      expect(result.status).toBe(prepareExit);
      expect(readFileSync(join(root, "events"), "utf8")).toBe("prepared");
      expect(readFileSync(join(bin, "remi"), "utf8")).toBe(prepareExit === 0 ? newBinary : oldBinary);
      if (prepareExit) expect(result.stderr).toContain("existing remi binary was not replaced");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
