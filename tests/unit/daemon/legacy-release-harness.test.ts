import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonV1ReleaseHarness, daemonV1Asset, daemonV1TestEnv, localDaemonTestUrl } from "../../fixtures/daemon-v1-release.js";

it("pins the published v0.2.82 archives for all supported release targets", () => {
  for (const platform of ["linux", "darwin"] as const) {
    for (const arch of ["x64", "arm64"] as const) {
      const asset = daemonV1Asset(platform, arch);
      expect(asset.name).toBe(`remi-0.2.82-${platform}-${arch}.tar.gz`);
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.url).toBe(`https://github.com/Grassgod/Remi/releases/download/v0.2.82/${asset.name}`);
    }
  }
  expect(() => daemonV1Asset("win32", "x64")).toThrow("No v0.2.82 release fixture");
});

it.each(["http://example.com:6120", "https://127.0.0.1:6120", "http://127.0.0.1", "http://127.0.0.1:6120/production", "http://127.0.0.1:6120/?token=fixture", "http://fixture@127.0.0.1:6120"])("rejects a non-isolated release daemon target (%s)", value => {
  expect(() => localDaemonTestUrl(value)).toThrow("explicit local HTTP server port");
});

it("uses only explicit fixture credentials and state directories, not the parent environment", () => {
  expect(localDaemonTestUrl("http://127.0.0.1:6120/")).toBe("http://127.0.0.1:6120");
  const env = daemonV1TestEnv("/tmp/legacy-fixture", "http://127.0.0.1:6120", "isolated-fixture-token", "http://127.0.0.1:6121/installer.sh");
  expect(env.MULTIREMI_TOKEN).toBe("isolated-fixture-token");
  expect(env.HOME).toBe("/tmp/legacy-fixture/home");
  expect(env.MULTIREMI_BIN_DIR).toBe("/tmp/legacy-fixture/payload");
  expect(env).not.toHaveProperty("INVOCATION_ID");
  expect(env).not.toHaveProperty("XPC_SERVICE_NAME");
  expect(env).not.toHaveProperty("MULTIREMI_DATABASE_URL");
  expect(env).not.toHaveProperty("FAKE_AGY_CAPTURE");
});

it("rejects an unverified archive before executing or extracting it", () => {
  const root = mkdtempSync(join(tmpdir(), "mul418-corrupt-release-"));
  try {
    const archive = join(root, "release.tar.gz");
    writeFileSync(archive, "not the published binary");
    expect(() => DaemonV1ReleaseHarness.prepare(archive)).toThrow("SHA-256 mismatch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
