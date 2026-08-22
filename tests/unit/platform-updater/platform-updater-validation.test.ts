import { describe, expect, it } from "bun:test";
import type { MultiremiPlatformOperation } from "@multiremi/contracts";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import { fetchReleaseFeed } from "@remi-platform/updater/release-feed.js";
import { SystemdReleaseDriver } from "@remi-platform/updater/systemd-release-driver.js";
import type { CommandRunner } from "@remi-platform/updater/types.js";

const unusedRunner: CommandRunner = {
  async run() {
    throw new Error("validation should fail before commands run");
  },
};

describe("platform updater release validation", () => {
  it("rejects mutable compose images before changing the host", async () => {
    const driver = new DockerComposeDriver({
      composeFile: "/tmp/compose.yml",
      envFile: "/tmp/platform.env",
      stateDir: "/tmp/platform-state",
      apiHealthUrl: "http://127.0.0.1:6120/readyz",
      webHealthUrl: "http://127.0.0.1:3000/login",
    }, unusedRunner);

    await expect(driver.execute(operation({
      version: "0.2.43",
      ref: "release-ref",
      apiImage: "ghcr.io/example/remi-api:latest",
      webImage: `ghcr.io/example/remi-web@sha256:${"a".repeat(64)}`,
    }), async () => {})).rejects.toThrow("immutable GHCR digest");
  });

  it("rejects non-HTTPS systemd release archives", async () => {
    const driver = new SystemdReleaseDriver({
      root: "/tmp/platform-root",
      apiService: "api.service",
      webService: "web.service",
      apiHealthUrl: "http://127.0.0.1:6120/readyz",
      webHealthUrl: "http://127.0.0.1:3000/login",
      bunExecutable: "/usr/local/bin/bun",
    }, unusedRunner);

    await expect(driver.execute(operation({
      version: "0.2.43",
      ref: "release-ref",
      sourceUrl: "http://example.com/release.tar.gz",
      sourceSha256: "a".repeat(64),
    }), async () => {})).rejects.toThrow("must use HTTPS");
  });

  it("rejects an insecure release feed URL before fetching", async () => {
    await expect(fetchReleaseFeed("http://example.com/platform-release.json"))
      .rejects.toThrow("must use HTTPS");
  });
});

function operation(targetManifest: Record<string, unknown>): MultiremiPlatformOperation {
  return {
    id: "pop_test",
    kind: "update",
    status: "preparing",
    driver: "docker_compose",
    targetVersion: "0.2.43",
    targetRef: "https://example.com/platform-release.json",
    targetManifest,
    progress: {},
    requestedBy: "local",
    output: null,
    error: null,
    previousRelease: null,
    resultRelease: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    finishedAt: null,
  };
}
