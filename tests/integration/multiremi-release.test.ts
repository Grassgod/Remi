import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMultiremiBinaryVersion,
  copyMultiremiSqliteVecExtension,
  createMultiremiArchive,
  MULTIREMI_ARCHIVE_ENTRIES,
  MULTIREMI_RELEASE_TARGETS,
  multiremiArchiveEntries,
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
      const target = { os: "linux", arch: "x64" };
      for (const entry of multiremiArchiveEntries(target)) {
        const path = join(targetDir, entry);
        writeFileSync(path, `#!/bin/sh\necho ${entry}\n`);
        chmodSync(path, 0o755);
      }

      const archive = join(root, "multiremi-0.2.0-test-linux-x64.tar.gz");
      createMultiremiArchive(targetDir, archive, target, "pipe");

      const contents = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
        .trim()
        .split("\n");
      expect(contents).toEqual([...MULTIREMI_ARCHIVE_ENTRIES, "vec0.so"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails the build when a target sqlite-vec extension is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-native-check-"));
    try {
      expect(() => copyMultiremiSqliteVecExtension(
        { os: "linux", arch: "arm64" },
        root,
        () => { throw new Error("module not found"); },
      )).toThrow("missing sqlite-vec native extension for linux-arm64");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("installs a historical archive without sqlite-vec in non-vector mode", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-legacy-install-"));
    try {
      const archiveDir = join(root, "archive");
      const fakeBin = join(root, "bin");
      const installDir = join(root, "install");
      mkdirSync(archiveDir, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(installDir, { recursive: true });

      for (const entry of MULTIREMI_ARCHIVE_ENTRIES) {
        const path = join(archiveDir, entry);
        writeFileSync(path, `#!/bin/sh\necho ${entry}\n`);
        chmodSync(path, 0o755);
      }
      const archive = join(root, "remi-0.2.53-linux-x64.tar.gz");
      execFileSync("tar", ["czf", archive, "-C", archiveDir, ...MULTIREMI_ARCHIVE_ENTRIES]);

      const fakeCurl = join(fakeBin, "curl");
      writeFileSync(fakeCurl, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    cp "$TEST_RELEASE_ARCHIVE" "$1"
    exit
  fi
  shift
done
exit 1
`);
      chmodSync(fakeCurl, 0o755);

      const fakeUname = join(fakeBin, "uname");
      writeFileSync(fakeUname, `#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo x86_64 ;;
  *) exit 1 ;;
esac
`);
      chmodSync(fakeUname, 0o755);

      const result = spawnSync("bash", [join(process.cwd(), "scripts", "install-remi.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          MULTIREMI_BIN_DIR: installDir,
          MULTIREMI_VERSION: "0.2.53",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TEST_RELEASE_ARCHIVE: archive,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("WARNING: Release archive is missing vec0.so");
      expect(result.stderr).toContain("other CLI functionality remains available");
      expect(existsSync(join(installDir, "remi"))).toBe(true);
      expect(existsSync(join(installDir, "remi-claude-agent-acp"))).toBe(true);
      expect(existsSync(join(installDir, "vec0.so"))).toBe(false);
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
});
