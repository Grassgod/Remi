// Sibling test for packages/server/src/api/helpers/integrations.ts.
//
// MULTIREMI_REPO_ROOT is computed by walking `..` up from `import.meta.dir`, so it silently
// breaks whenever the module changes directory depth — which is exactly what happened when
// api/helpers.ts was carved into api/helpers/*. Nothing else in the suite reaches the release
// mirror, so these assertions are its only guard.
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MULTIREMI_RELEASE_TARBALL_RE,
  MULTIREMI_REPO_ROOT,
  compareMultiremiVersions,
  multiremiReleaseDir,
  multiremiScriptsDir,
  resolveMirrorReleaseFile,
} from "@multiremi/api/helpers/integrations.js";

describe("release mirror paths", () => {
  it("resolves MULTIREMI_REPO_ROOT to the actual repository root", () => {
    // Landmarks that only exist at the root — not under packages/ or packages/server/.
    expect(existsSync(join(MULTIREMI_REPO_ROOT, "bunfig.toml"))).toBe(true);
    expect(existsSync(join(MULTIREMI_REPO_ROOT, "bun.lock"))).toBe(true);
    expect(existsSync(join(MULTIREMI_REPO_ROOT, "scripts", "install-remi.sh"))).toBe(true);
    expect(existsSync(join(MULTIREMI_REPO_ROOT, "packages", "server"))).toBe(true);
  });

  it("derives the release and script directories from the repo root", () => {
    expect(multiremiReleaseDir()).toBe(join(MULTIREMI_REPO_ROOT, "dist"));
    expect(multiremiScriptsDir()).toBe(join(MULTIREMI_REPO_ROOT, "scripts"));
    expect(existsSync(multiremiScriptsDir())).toBe(true);
  });

  it("serves an install script that exists and refuses traversal", () => {
    expect(resolveMirrorReleaseFile("install-remi.sh")).toBe(join(multiremiScriptsDir(), "install-remi.sh"));
    expect(resolveMirrorReleaseFile("../../etc/passwd")).toBeNull();
    expect(resolveMirrorReleaseFile("install.sh/../../x")).toBeNull();
    expect(resolveMirrorReleaseFile(undefined)).toBeNull();
    expect(resolveMirrorReleaseFile("remi-9.9.9-linux-x64.tar.gz")).toBeNull(); // not built here
  });

  it("matches release tarball names and orders versions numerically", () => {
    expect("remi-0.2.23-linux-x64.tar.gz".match(MULTIREMI_RELEASE_TARBALL_RE)?.[1]).toBe("0.2.23");
    expect("multiremi-1.0.0-darwin-arm64.tar.gz".match(MULTIREMI_RELEASE_TARBALL_RE)?.[1]).toBe("1.0.0");
    expect(MULTIREMI_RELEASE_TARBALL_RE.test("remi-latest-linux-x64.tar.gz")).toBe(false);
    expect(["0.2.9", "0.10.0", "0.2.23"].sort(compareMultiremiVersions)).toEqual(["0.2.9", "0.2.23", "0.10.0"]);
  });
});
